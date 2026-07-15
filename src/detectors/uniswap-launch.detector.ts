import { randomUUID } from 'node:crypto'
import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
import {
  STREAMS,
  type ParsedEvent,
  type PoolCreatedEvent,
  type CandidateOpportunity,
} from '../events/event-types.js'
import {
  analyzeSymbol,
  analyzeName,
  scoreDeployer,
  stringSimilarity,
  normalizeSymbol,
} from '../analysis/token-analyzer.js'

const log = createChildLogger('uniswap-launch-detector')

// EVM address validator — standard 0x-prefixed 40-char hex address.
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

// ── Enhanced spam detection constants ─────────────────────────────────────────

/** Tokens with the same normalized symbol deployed within this window = spam cluster. */
const FUZZY_SYMBOL_WINDOW_MS = 120_000 // 2 min

/** Similarity threshold above which two symbols are considered the "same". */
const FUZZY_SYMBOL_THRESHOLD = 0.8

/** Same deployer creating > this many tokens within the burst window = spam factory. */
const DEPLOYER_BURST_MAX = 5

/** Burst window for deployer cascade detection. */
const DEPLOYER_BURST_WINDOW_MS = 300_000 // 5 min

interface DetectorOptions {
  blockMs?: number
  count?: number
  consumerGroup?: string
  /** Discard events older than this many ms (stale tx, slow parser, etc.). Default 30s. */
  maxAgeMs?: number
}

export class UniswapLaunchDetector {
  private running = false
  private readonly blockMs: number
  private readonly count: number
  private readonly consumerGroup: string
  private readonly maxAgeMs: number

  // Dedup cache — same token mint event delivered twice should not double-publish
  private readonly seenTokens = new Map<string, number>()
  private readonly seenTokensMax = 5_000
  private readonly seenTokensTtlMs = 60 * 60 * 1_000 // 1h

  // Spam attack detection — exact match on (symbol, name)
  private readonly recentMetadata = new Map<string, number>()
  private readonly spamWindowMs = 60_000
  private readonly recentMetadataMax = 2_000

  // Fuzzy symbol matching for spam clusters
  // Maps normalizedSymbol → { count, firstSeenAt, lastSeenAt, symbols: Set }
  private readonly fuzzySymbolCache = new Map<string, {
    count: number
    firstSeenAt: number
    lastSeenAt: number
    symbols: Set<string>
  }>()
  private readonly fuzzySymbolCacheMax = 3_000

  // Deployer burst tracking
  // Maps deployerAddress → { count, firstSeenAt, lastSeenAt }
  private readonly deployerBurstCache = new Map<string, {
    count: number
    firstSeenAt: number
    lastSeenAt: number
  }>()
  private readonly deployerBurstCacheMax = 2_000

  constructor(options: DetectorOptions = {}) {
    this.blockMs = options.blockMs ?? 2_000
    this.count = options.count ?? 20
    this.consumerGroup = options.consumerGroup ?? 'uniswap-launch-detector'
    this.maxAgeMs = options.maxAgeMs ?? 90_000
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn('start() called but already running')
      return
    }

    await eventBus.subscribe(
      STREAMS.PARSED,
      this.consumerGroup,
      `detector-${process.pid}`,
      async (data, messageId) => {
        await this.handleParsedEvent(data, messageId)
      },
      { blockMs: this.blockMs, count: this.count },
    )

    this.running = true
    log.info(
      { stream: STREAMS.PARSED, group: this.consumerGroup },
      'UniswapLaunchDetector subscribed (EVM — Uniswap V2, enhanced multi-dimension scoring)',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    this.seenTokens.clear()
    this.recentMetadata.clear()
    this.fuzzySymbolCache.clear()
    this.deployerBurstCache.clear()
    log.info('UniswapLaunchDetector stopped')
  }

  // ── Handler ────────────────────────────────────────────────────────────────

  private async handleParsedEvent(
    data: Record<string, unknown>,
    messageId: string,
  ): Promise<void> {
    const event = data as unknown as ParsedEvent

    if (event.protocol !== 'uniswap') return
    if (event.type !== 'pool_created') return

    try {
      const candidate = await this.evaluate(event)
      if (!candidate) return

      await eventBus.publish(
        STREAMS.CANDIDATES,
        candidate as unknown as Record<string, unknown>,
      )
      log.debug(
        {
          tokenAddress: candidate.tokenAddress,
          poolAddress: candidate.poolAddress,
          deployer: candidate.deployerAddress,
          score: candidate.detectorScore,
        },
        'Candidate opportunity published',
      )
    } catch (err) {
      log.error({ err, messageId }, 'Detector evaluation failed')
    }
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  private async evaluate(event: PoolCreatedEvent): Promise<CandidateOpportunity | null> {
    const {
      tokenAddress,
      poolAddress,
      deployerAddress,
      timestamp,
    } = event

    // Required address validation (EVM)
    if (!isValidEvmAddress(tokenAddress)) {
      log.debug({ tokenAddress }, 'Invalid token address — discard')
      return null
    }
    if (!isValidEvmAddress(poolAddress)) {
      log.debug({ poolAddress }, 'Invalid pool address — discard')
      return null
    }
    if (!isValidEvmAddress(deployerAddress)) {
      log.debug({ deployerAddress }, 'Invalid deployer address — discard')
      return null
    }

    // Reject events older than maxAgeMs — stale txs can't be profitably entered
    const ageMs = Date.now() - timestamp
    if (ageMs > this.maxAgeMs) {
      log.debug({ tokenAddress, ageMs, maxAgeMs: this.maxAgeMs }, 'Event too old — discard')
      return null
    }

    // Dedup — same token should only emit one candidate
    if (this.isDuplicate(tokenAddress)) {
      log.debug({ tokenAddress }, 'Duplicate token — discard')
      return null
    }
    this.recordSeen(tokenAddress)

    // Spam attack guard: reject if same metadata (symbol+name) seen recently
    if (this.isSpamPattern(event)) {
      log.warn(
        {
          tokenAddress,
          symbol: event.tokenMetadata?.symbol,
          name: event.tokenMetadata?.name,
        },
        'SPAM PATTERN — duplicate symbol+name within window, rejecting',
      )
      return null
    }

    // Fuzzy symbol spam cluster detection
    if (this.isFuzzySymbolSpam(event)) {
      log.warn(
        {
          tokenAddress,
          symbol: event.tokenMetadata?.symbol,
        },
        'FUZZY SYMBOL SPAM — similar symbol deployed recently, rejecting',
      )
      return null
    }

    // Deployer burst detection — same wallet creating too many tokens
    if (this.isDeployerBurst(deployerAddress)) {
      log.warn(
        {
          tokenAddress,
          deployerAddress: deployerAddress.slice(0, 12),
        },
        'DEPLOYER BURST — serial deployer detected, rejecting',
      )
      return null
    }

    // Score the launch using multi-dimensional analysis (fast, no I/O)
    const score = await this.scoreLaunch(event)

    // Minimum score gate — tokens scoring too low are clear spam
    if (score < 15) {
      log.debug(
        { tokenAddress, score },
        'Composite score too low — discard',
      )
      return null
    }

    // Compute initial liquidity from reserves (one side is ETH)
    const reserve0 = event.reserve0 ? parseFloat(event.reserve0) / 1e18 : 0
    const reserve1 = event.reserve1 ? parseFloat(event.reserve1) / 1e18 : 0
    const initialLiquidityNative = Math.max(reserve0, reserve1)

    const candidate: CandidateOpportunity = {
      candidateId: randomUUID(),
      timestamp: Date.now(),
      protocol: 'uniswap',
      tokenAddress,
      poolAddress,
      deployerAddress,
      initialLiquidityNative,
      detectorScore: score,
      sourceEvent: event,
    }
    return candidate
  }

  // ── Multi-dimensional scoring ──────────────────────────────────────────────

  /**
   * Score this Uniswap V2 launch using multiple dimensions.
   * Fast path only — no HTTP/IO. Metadata fetch happens later in strategy.
   *
   * Dimensions (each 0-100):
   *   - Symbol quality (weight 0.35)
   *   - Name quality (weight 0.25)
   *   - Metadata-lite: name/symbol length sanity only (weight 0.15)
   *   - Deployer reputation from local cache (weight 0.25)
   *
   * Note: Dev buy is NOT a dimension — Uniswap pair creation doesn't expose
   * the creator's individual buy. Token age is handled downstream.
   *
   * Returns 0-100 composite.
   */
  private async scoreLaunch(event: PoolCreatedEvent): Promise<number> {
    const md = event.tokenMetadata

    // 1. Symbol quality (weight: 0.30)
    const symResult = analyzeSymbol(md?.symbol)
    const symScore = symResult.score
    if (symResult.flags.length > 0) {
      log.debug(
        { symbol: md?.symbol, score: symScore, flags: symResult.flags },
        'Symbol quality analysis',
      )
    }

    // 2. Name quality (weight: 0.20)
    const nameResult = analyzeName(md?.name)
    const nameScore = nameResult.score
    if (nameResult.flags.length > 0) {
      log.debug(
        { name: md?.name?.slice(0, 40), score: nameScore, flags: nameResult.flags },
        'Name quality analysis',
      )
    }

    // 3. Metadata-lite signals (weight: 0.15)
    // Plain ERC-20s carry only name/symbol on-chain — there is no metadata URI
    // (that was a Pump.fun/Solana concept). Score only what exists, rescaled to
    // 0-100 so this dimension isn't permanently capped.
    let metaScore = 0
    if (md?.name && md.name.length >= 3 && md.name.length <= 32) metaScore += 50 // Sane name length
    if (md?.symbol && md.symbol.length >= 2 && md.symbol.length <= 10) metaScore += 50 // Sane symbol length

    // 4. Deployer reputation from local burst cache (weight: 0.25)
    // We already track deployer activity in-memory via deployerBurstCache
    const burstInfo = this.deployerBurstCache.get(event.deployerAddress)
    let deployerScore = 50 // default neutral
    if (burstInfo && burstInfo.count > 1) {
      if (burstInfo.count >= DEPLOYER_BURST_MAX) deployerScore = 0
      else if (burstInfo.count > 3) deployerScore = 15
      else if (burstInfo.count > 1) deployerScore = 30
    }

    // Weighted composite — EVM-available dimensions only
    const composite = Math.round(
      symScore * 0.35 +
      nameScore * 0.25 +
      metaScore * 0.15 +
      deployerScore * 0.25,
    )

    log.debug(
      {
        token: md?.symbol ?? event.tokenAddress.slice(0, 10),
        symScore,
        nameScore,
        metaScore,
        deployerScore,
        composite,
      },
      'Uniswap launch multi-dimension score',
    )

    return Math.max(0, Math.min(100, composite))
  }

  // ── Dedup cache ────────────────────────────────────────────────────────────

  private isDuplicate(tokenAddress: string): boolean {
    const seenAt = this.seenTokens.get(tokenAddress)
    if (seenAt === undefined) return false
    if (Date.now() - seenAt > this.seenTokensTtlMs) {
      this.seenTokens.delete(tokenAddress)
      return false
    }
    return true
  }

  private recordSeen(tokenAddress: string): void {
    if (this.seenTokens.size >= this.seenTokensMax) {
      const firstKey = this.seenTokens.keys().next().value
      if (firstKey !== undefined) this.seenTokens.delete(firstKey)
    }
    this.seenTokens.set(tokenAddress, Date.now())
  }

  // ── Spam: exact metadata match ─────────────────────────────────────────────

  private isSpamPattern(event: PoolCreatedEvent): boolean {
    const md = event.tokenMetadata
    const symbol = md?.symbol?.trim()
    const name = md?.name?.trim()
    if (!symbol && !name) return false

    const key = `${symbol ?? ''}::${name ?? ''}`
    const now = Date.now()
    const lastSeen = this.recentMetadata.get(key)

    // Periodic GC
    if (this.recentMetadata.size >= this.recentMetadataMax) {
      for (const [k, ts] of this.recentMetadata) {
        if (now - ts > this.spamWindowMs) this.recentMetadata.delete(k)
      }
    }

    this.recentMetadata.set(key, now)
    return lastSeen !== undefined && now - lastSeen < this.spamWindowMs
  }

  // ── Fuzzy symbol spam detection ───────────────────────────────────────────

  /**
   * Detects spam clusters where scammers deploy tokens with slight symbol variations.
   * Example: SHIB, SH1B, SHIB2, SHIB3 within 2 minutes.
   *
   * Normalizes symbols (lowercase, leet substitution → stripped) and checks
   * against recently seen normalized symbols.
   */
  private isFuzzySymbolSpam(event: PoolCreatedEvent): boolean {
    const rawSymbol = event.tokenMetadata?.symbol?.trim()
    if (!rawSymbol) return false

    const normalized = normalizeSymbol(rawSymbol)
    if (normalized.length < 2) return false

    const now = Date.now()

    // Periodic GC
    if (this.fuzzySymbolCache.size >= this.fuzzySymbolCacheMax) {
      for (const [k, v] of this.fuzzySymbolCache) {
        if (now - v.lastSeenAt > FUZZY_SYMBOL_WINDOW_MS) {
          this.fuzzySymbolCache.delete(k)
        }
      }
    }

    // Check existing entries for fuzzy matches
    for (const [cachedNorm, entry] of this.fuzzySymbolCache) {
      if (now - entry.lastSeenAt > FUZZY_SYMBOL_WINDOW_MS) continue

      // Exact normalized match = same symbol with leet substitutions
      if (cachedNorm === normalized) {
        // Don't mark as spam on FIRST duplicate — scammers usually make 2+ copies
        if (entry.count >= 1) {
          entry.count++
          entry.lastSeenAt = now
          entry.symbols.add(rawSymbol)
          return true
        }
        entry.count++
        entry.lastSeenAt = now
        entry.symbols.add(rawSymbol)
        return false
      }

      // Fuzzy match: high similarity but not identical
      const similarity = stringSimilarity(cachedNorm, normalized)
      if (similarity >= FUZZY_SYMBOL_THRESHOLD) {
        log.debug(
          { normalized, cachedNorm, similarity: similarity.toFixed(2) },
          'Fuzzy symbol match detected',
        )
        entry.count++
        entry.lastSeenAt = now
        entry.symbols.add(rawSymbol)
        // If we've seen too many similar symbols, it's a spam cluster
        if (entry.count >= 3) return true
      }
    }

    // Record this normalized symbol
    this.fuzzySymbolCache.set(normalized, {
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      symbols: new Set([rawSymbol]),
    })

    return false
  }

  // ── Deployer burst detection ─────────────────────────────────────────

  /**
   * Detects serial deployers creating many tokens in a short time window.
   * Legitimate creators deploy 1-2 tokens; scammers deploy 10+ in minutes.
   */
  private isDeployerBurst(deployerAddress: string): boolean {
    const now = Date.now()

    // Periodic GC
    if (this.deployerBurstCache.size >= this.deployerBurstCacheMax) {
      for (const [k, v] of this.deployerBurstCache) {
        if (now - v.lastSeenAt > DEPLOYER_BURST_WINDOW_MS) {
          this.deployerBurstCache.delete(k)
        }
      }
    }

    const existing = this.deployerBurstCache.get(deployerAddress)

    if (existing) {
      // Update or reset burst window
      if (now - existing.firstSeenAt > DEPLOYER_BURST_WINDOW_MS) {
        // Window expired, reset
        this.deployerBurstCache.set(deployerAddress, {
          count: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        return false
      }

      existing.count++
      existing.lastSeenAt = now

      if (existing.count >= DEPLOYER_BURST_MAX) {
        return true
      }
    } else {
      this.deployerBurstCache.set(deployerAddress, {
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })
    }

    return false
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidEvmAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && EVM_ADDRESS_RE.test(addr)
}

export const uniswapLaunchDetector = new UniswapLaunchDetector()
