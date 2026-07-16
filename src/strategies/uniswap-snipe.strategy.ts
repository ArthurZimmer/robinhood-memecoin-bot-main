import { randomUUID } from 'node:crypto'
import { Contract } from 'ethers'
import { env } from '../config/env.js'
import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
import { paperExecutor } from '../executor/paper.executor.js'
import { realExecutor } from '../executor/real.executor.js'
import { rhProvider, WETH_ADDRESS } from '../utils/robbinhood.utils.js'
import {
  UNISWAP_PAIR_ABI,
  getRawPairReserves,
  getTokenDecimals,
  getTokenTotalSupply,
  type RawPairReserves,
} from '../executor/uniswap-math.js'
import {
  analyzeToken,
  type TokenAnalysis,
} from '../analysis/token-analyzer.js'
import {
  countOpenPositions,
  countRecentProfitableClosesBySymbol,
  todayRealizedPnlNative,
} from '../positions/position.repository.js'
import {
  STREAMS,
  type ApprovedOpportunity,
  type TradeSignal,
  type PoolCreatedEvent,
} from '../events/event-types.js'
import { probeToken, passesHoneypotGate } from '../risk/honeypot-probe.js'
import { scanTokenCapabilities } from '../risk/capability-scan.js'
import type { BaseStrategy } from './base.strategy.js'
import type { BaseExecutor } from '../executor/base.executor.js'

const log = createChildLogger('uniswap-snipe-strategy')

// ── Uniswap V2 snipe strategy v1 ─────────────────────────────────────────────
// Multi-tier entry system for Uniswap V2 pairs on Robinhood Chain.
//
// Tier 1 (MC ≥ $8k):  Easy requirements — score ≥ MIN_DETECTOR_SCORE
// Tier 2 (MC $3k-$8k): Moderate requirements — score ≥ MIN_DETECTOR_SCORE_TIER2
//                      + social links required if REQUIRE_SOCIAL_TIER2
// Tier 3 (MC $1.5k-$3k): Hard requirements — score ≥ MIN_DETECTOR_SCORE_TIER3
//                      + fresh deployer if REQUIRE_FRESH_DEPLOYER_TIER3
// Below $1.5k:         REJECTED unconditionally
//
// Additional gates:
//   - Token age ≥ MIN_TOKEN_AGE_MS (default 3s) — prevents atomic rug pulls.
//     Too-young candidates are re-evaluated at minimum age instead of dropped.
//   - Position cap, daily loss limit (unchanged)

const SLIPPAGE_BPS = 1_500
const SIGNAL_TTL_MS = 5_000
const MAX_SIGNAL_AGE_MS = 30_000
const RESERVE_FETCH_TIMEOUT_MS = 2_000
// Retry reserves fetch when pair just created (PairCreated fires before LP is added)
const MC_FETCH_MAX_RETRIES = 3
const MC_FETCH_RETRY_DELAY_MS = 1_500
// Too-young candidates are re-evaluated once MIN_TOKEN_AGE_MS is reached instead
// of dropped. Buffer absorbs timer imprecision so the retry lands past the gate.
const AGE_RETRY_BUFFER_MS = 250

// ── Tier determination ───────────────────────────────────────────────────────

type EntryTier = 'tier1' | 'tier2' | 'tier3' | 'rejected'

interface TierDecision {
  tier: EntryTier
  reason: string
}

/** Live snapshot of a Uniswap V2 pair used for tier + entry decisions. */
interface PairSnapshot {
  /** Market cap in USD (spot price × token total supply × ETH/USD). */
  mcUsd: number
  /** ETH reserve in the pool (native units). */
  ethReserve: number
  /** Memecoin reserve in the pool (whole tokens). */
  tokenReserveNum: number
  /** Token total supply (whole tokens). */
  totalSupplyNum: number
  /** Percent of total supply sitting in the pool — high = less held by dev/insiders. */
  supplyInPoolPct: number
  /** ETH/USD rate used for the MC computation. */
  ethUsd: number
  /** Fresh raw reserve0 (wei, token0 order) — stamped onto the signal so the executor uses live liquidity. */
  rawReserve0: string
  /** Fresh raw reserve1 (wei, token1 order). */
  rawReserve1: string
  /** Fresh raw token total supply. */
  rawTotalSupply: string
}

function determineTier(mcUsd: number): TierDecision {
  if (mcUsd < env.MIN_ENTRY_MC_USD) {
    return { tier: 'rejected', reason: `MC $${mcUsd.toFixed(0)} < floor $${env.MIN_ENTRY_MC_USD}` }
  }
  if (mcUsd >= env.TIER1_MC_USD) {
    return { tier: 'tier1', reason: `MC $${mcUsd.toFixed(0)} ≥ tier1 $${env.TIER1_MC_USD}` }
  }
  if (mcUsd >= env.TIER2_MC_USD) {
    return { tier: 'tier2', reason: `MC $${mcUsd.toFixed(0)} ≥ tier2 $${env.TIER2_MC_USD}` }
  }
  return { tier: 'tier3', reason: `MC $${mcUsd.toFixed(0)} ≥ floor $${env.MIN_ENTRY_MC_USD}` }
}

interface StrategyOptions {
  blockMs?: number
  count?: number
  consumerGroup?: string
  executor?: BaseExecutor
}

export class UniswapSnipeStrategy implements BaseStrategy {
  readonly name = 'uniswap-snipe-v1'

  private running = false
  private readonly blockMs: number
  private readonly count: number
  private readonly consumerGroup: string
  private readonly executor: BaseExecutor

  // ── Token analysis cache ─────────────────────────────────────────────────
  private readonly analysisCache = new Map<string, TokenAnalysis>()
  private readonly analysisCacheMax = 1_000

  // ── Too-young candidates awaiting re-evaluation at minimum age ────────────
  private readonly pendingAgeRetries = new Map<string, NodeJS.Timeout>()

  constructor(options: StrategyOptions = {}) {
    this.blockMs = options.blockMs ?? 2_000
    this.count = options.count ?? 5
    this.consumerGroup = options.consumerGroup ?? 'uniswap-snipe-strategy'
    this.executor = options.executor ?? paperExecutor
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn('start() called but already running')
      return
    }

    await eventBus.subscribe(
      STREAMS.APPROVED,
      this.consumerGroup,
      `strategy-${process.pid}`,
      async (data, messageId) => {
        await this.handleApproved(data as unknown as ApprovedOpportunity, messageId)
      },
      { blockMs: this.blockMs, count: this.count },
    )

    this.running = true
    log.info(
      {
        executor: this.executor.mode,
        tradeSizeNative: env.TRADE_SIZE_NATIVE,
        maxOpen: env.MAX_OPEN_POSITIONS,
        dailyLossLimitNative: env.DAILY_LOSS_LIMIT_NATIVE,
        tiers: {
          tier1: `MC ≥ $${env.TIER1_MC_USD} → score ≥ ${env.MIN_DETECTOR_SCORE}`,
          tier2: `MC ≥ $${env.TIER2_MC_USD} → score ≥ ${env.MIN_DETECTOR_SCORE_TIER2}, supplyInPool ≥ ${env.TIER2_MIN_SUPPLY_IN_POOL_PCT}%`,
          tier3: `MC ≥ $${env.MIN_ENTRY_MC_USD} → score ≥ ${env.MIN_DETECTOR_SCORE_TIER3}, supplyInPool ≥ ${env.TIER3_MIN_SUPPLY_IN_POOL_PCT}%, freshDeployer required`,
        },
        honeypot: `maxBuyTax ${env.HONEYPOT_MAX_BUY_TAX_PCT}%, maxSellTax ${env.HONEYPOT_MAX_SELL_TAX_PCT}%`,
        minTokenAgeMs: env.MIN_TOKEN_AGE_MS,
      },
      'UniswapSnipeStrategy v1 subscribed (Uniswap V2 on Robinhood Chain)',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    this.analysisCache.clear()
    for (const timer of this.pendingAgeRetries.values()) clearTimeout(timer)
    this.pendingAgeRetries.clear()
    log.info('UniswapSnipeStrategy stopped')
  }

  // ── Strategy decision ──────────────────────────────────────────────────────

  async decide(opp: ApprovedOpportunity): Promise<TradeSignal | null> {
    // Only handle Uniswap protocol opportunities
    if (opp.protocol !== 'uniswap') return null

    // Age gate — opportunity must be fresh
    const ageMs = Date.now() - opp.timestamp
    if (ageMs > MAX_SIGNAL_AGE_MS) {
      log.debug({ tokenAddress: opp.tokenAddress, ageMs }, 'Opportunity stale — skip')
      return null
    }

    // Position cap
    const open = await countOpenPositions(this.executor.mode)
    if (open >= env.MAX_OPEN_POSITIONS) {
      log.debug(
        { tokenAddress: opp.tokenAddress, open, cap: env.MAX_OPEN_POSITIONS },
        'Max open positions reached — skip',
      )
      return null
    }

    // Daily loss kill switch
    const todayPnl = await todayRealizedPnlNative(this.executor.mode)
    if (todayPnl <= -env.DAILY_LOSS_LIMIT_NATIVE) {
      log.warn(
        { todayPnl, limit: env.DAILY_LOSS_LIMIT_NATIVE, tokenAddress: opp.tokenAddress },
        'Daily loss limit hit — skip',
      )
      return null
    }

    // ── Token age gate ───────────────────────────────────────────────────────
    const source = opp.sourceEvent as PoolCreatedEvent
    const tokenAgeMs = Date.now() - (source.timestamp ?? opp.timestamp)

    // ── Anti-copycat gate ────────────────────────────────────────────────────
    // Rug factories relaunch the ticker of a token that just pumped (often one
    // we took profit on minutes earlier) and pull the LP ~20min in. A recent
    // profitable close on the same symbol marks this launch as bait.
    const candidateSymbol = source.tokenMetadata?.symbol
    if (candidateSymbol && env.COPYCAT_SYMBOL_COOLDOWN_MIN > 0) {
      const recentWins = await countRecentProfitableClosesBySymbol(
        this.executor.mode,
        candidateSymbol,
        env.COPYCAT_SYMBOL_COOLDOWN_MIN * 60_000,
      )
      if (recentWins > 0) {
        log.warn(
          {
            tokenAddress: opp.tokenAddress,
            symbol: candidateSymbol,
            cooldownMin: env.COPYCAT_SYMBOL_COOLDOWN_MIN,
          },
          'Copycat symbol relaunch — skip',
        )
        return null
      }
    }
    if (tokenAgeMs < env.MIN_TOKEN_AGE_MS) {
      log.debug(
        { tokenAddress: opp.tokenAddress, tokenAgeMs, min: env.MIN_TOKEN_AGE_MS },
        'Token too young — waiting for minimum age',
      )
      return null
    }
    // ── Fetch live pair snapshot (reserves, MC, supply-in-pool) ──────────────────
    // Retry: PairCreated fires before initial LP is added to Uniswap V2 pairs.
    // Retry a few times with a short delay to catch the reserves as they land.
    let snapshot: PairSnapshot | null = null
    for (let attempt = 1; attempt <= MC_FETCH_MAX_RETRIES; attempt++) {
      snapshot = await this.fetchPairSnapshot(opp.poolAddress, opp.tokenAddress, source)
      if (snapshot !== null) break
      if (attempt < MC_FETCH_MAX_RETRIES) {
        log.debug(
          { tokenAddress: opp.tokenAddress, attempt },
          'Pair snapshot unavailable ─ retrying after delay',
        )
        await new Promise((r) => setTimeout(r, MC_FETCH_RETRY_DELAY_MS))
      }
    }

    // Fail-closed: without live reserves we can neither compute MC nor run the
    // honeypot probe. After MC_FETCH_MAX_RETRIES, missing reserves ≈ LP never
    // added (or RPC down) — either way the token is not safely buyable.
    if (snapshot === null) {
      log.info(
        { tokenAddress: opp.tokenAddress, symbol: source.tokenMetadata?.symbol ?? '?', reason: 'no-reserves' },
        'ENTRY REJECTED — pair reserves unavailable after retries (fail-closed)',
      )
      return null
    }

    // Stamp FRESH reserves onto the source event. At PairCreated time liquidity
    // is usually not added yet, so the event's reserve0/reserve1 are empty — the
    // executor (paper + real) reads those and would abort with "missing pair
    // reserves". We just fetched live reserves for the snapshot; reuse them so
    // the executor prices the buy off current liquidity (no extra RPC call).
    source.reserve0 = snapshot.rawReserve0
    source.reserve1 = snapshot.rawReserve1
    source.totalSupply = snapshot.rawTotalSupply

    // ── Tier decision ──────────────────────────────────────────────────────────
    const { tier, reason: tierReason } = determineTier(snapshot.mcUsd)

    if (tier === 'rejected') {
      log.info(
        { tokenAddress: opp.tokenAddress, symbol: source.tokenMetadata?.symbol ?? '?', mcUsd: snapshot.mcUsd, reason: tierReason },
        'ENTRY REJECTED — MC below floor',
      )
      return null
    }

    // ── Full token analysis (includes metadata fetch) ──────────────────────────
    let analysis = this.analysisCache.get(opp.tokenAddress)
    if (!analysis) {
      analysis = await analyzeToken(source)
      if (this.analysisCache.size >= this.analysisCacheMax) {
        const firstKey = this.analysisCache.keys().next().value
        if (firstKey !== undefined) this.analysisCache.delete(firstKey)
      }
      this.analysisCache.set(opp.tokenAddress, analysis)
    }

    // ── Tier-specific gates ────────────────────────────────────────────────────
    const passReason = this.checkTierGates(tier, snapshot, analysis, opp, source)
    if (!passReason) return null

    // ── Honeypot / tax probe (single eth_call, cached) ──────────────────────────
    // Runs for BOTH paper and real mode so paper metrics reflect un-sellable
    // tokens and fee-on-transfer taxes. Only reached by tokens that already
    // cleared every tier gate — minimal RPC cost.
    const probe = await probeToken(opp.tokenAddress)
    if (!passesHoneypotGate(probe)) {
      log.info(
        {
          tokenAddress: opp.tokenAddress,
          symbol: source.tokenMetadata?.symbol ?? '?',
          tier,
          ok: probe.ok,
          buyTaxPct: probe.buyTaxPct.toFixed(2),
          sellTaxPct: probe.sellTaxPct.toFixed(2),
          roundTripPct: probe.roundTripPct.toFixed(2),
          error: probe.error,
          maxBuyTax: env.HONEYPOT_MAX_BUY_TAX_PCT,
          maxSellTax: env.HONEYPOT_MAX_SELL_TAX_PCT,
        },
        'ENTRY REJECTED — honeypot probe failed',
      )
      return null
    }

    // ── Dynamic-honeypot capability scan (bytecode heuristic, cached) ───────────
    // The probe above proves the token is sellable NOW; this gate rejects tokens
    // whose non-renounced owner can later block exits (blacklist, pause, fee hike).
    const capabilities = await scanTokenCapabilities(opp.tokenAddress)
    if (!capabilities.ok) {
      log.info(
        {
          tokenAddress: opp.tokenAddress,
          symbol: source.tokenMetadata?.symbol ?? '?',
          tier,
          dangerous: capabilities.dangerous,
          ownerRenounced: capabilities.ownerRenounced,
          error: capabilities.error,
        },
        'ENTRY REJECTED — sell-blocking capabilities with live owner',
      )
      return null
    }

    // ── Build signal ───────────────────────────────────────────────────────────
    const now = Date.now()
    const signal: TradeSignal = {
      signalId: randomUUID(),
      timestamp: now,
      protocol: opp.protocol,
      tokenAddress: opp.tokenAddress,
      poolAddress: opp.poolAddress,
      action: 'buy',
      amountNative: env.TRADE_SIZE_NATIVE,
      slippageBps: SLIPPAGE_BPS,
      maxRetries: 1,
      expiresAt: now + SIGNAL_TTL_MS,
      strategy: this.name,
      opportunity: opp,
      honeypotProbe: {
        buyTaxPct: probe.buyTaxPct,
        sellTaxPct: probe.sellTaxPct,
        roundTripPct: probe.roundTripPct,
      },
    }

    log.info(
      {
        tokenAddress: opp.tokenAddress,
        symbol: source.tokenMetadata?.symbol ?? '?',
        tier,
        reason: passReason,
        mcUsd: snapshot.mcUsd,
        supplyInPoolPct: snapshot.supplyInPoolPct.toFixed(1),
        ethReserve: snapshot.ethReserve.toFixed(4),
        compositeScore: analysis.compositeScore,
        buyTaxPct: probe.buyTaxPct.toFixed(2),
        sellTaxPct: probe.sellTaxPct.toFixed(2),
      },
      '✅ ENTRY APPROVED — emitting buy signal',
    )
    return signal
  }

  /**
   * Apply tier-specific entry requirements.
   * Returns reason string if passed, null if rejected.
   */
  private checkTierGates(
    tier: EntryTier,
    snapshot: PairSnapshot,
    analysis: TokenAnalysis,
    _opp: ApprovedOpportunity,
    source: PoolCreatedEvent,
  ): string | null {
    const score = analysis.compositeScore
    const deployer = analysis.deployerStats
    const mcUsd = snapshot.mcUsd
    const symbol = source.tokenMetadata?.symbol ?? _opp.tokenAddress.slice(0, 10)

    // Helper to log a rejection at info level (needed to calibrate the funnel).
    const reject = (tierLabel: string, reason: string, extra: Record<string, unknown> = {}): null => {
      log.info(
        { token: _opp.tokenAddress.slice(0, 10), symbol, tier: tierLabel, mcUsd: mcUsd.toFixed(0), reason, ...extra },
        `ENTRY REJECTED — ${tierLabel} gate`,
      )
      return null
    }

    switch (tier) {
      case 'tier1': {
        // Highest MC, lowest bar — score only.
        if (score < env.MIN_DETECTOR_SCORE) {
          return reject('tier1', 'score too low', { score, required: env.MIN_DETECTOR_SCORE })
        }
        return `tier1: MC $${mcUsd.toFixed(0)}, score ${score}/${env.MIN_DETECTOR_SCORE}, supplyInPool ${snapshot.supplyInPoolPct.toFixed(0)}%`
      }

      case 'tier2': {
        if (score < env.MIN_DETECTOR_SCORE_TIER2) {
          return reject('tier2', 'score too low', { score, required: env.MIN_DETECTOR_SCORE_TIER2 })
        }
        // On-chain anti-dump gate (replaces the metadata-social gate that never
        // fired on EVM): most of the supply must sit in the pool, not in
        // dev/insider wallets ready to dump.
        if (snapshot.supplyInPoolPct < env.TIER2_MIN_SUPPLY_IN_POOL_PCT) {
          return reject('tier2', 'too much supply out of pool', {
            supplyInPoolPct: snapshot.supplyInPoolPct.toFixed(1),
            required: env.TIER2_MIN_SUPPLY_IN_POOL_PCT,
          })
        }
        if (snapshot.ethReserve < env.MIN_LIQUIDITY_NATIVE) {
          return reject('tier2', 'liquidity below floor', {
            ethReserve: snapshot.ethReserve.toFixed(4),
            required: env.MIN_LIQUIDITY_NATIVE,
          })
        }
        return `tier2: MC $${mcUsd.toFixed(0)}, score ${score}/${env.MIN_DETECTOR_SCORE_TIER2}, supplyInPool ${snapshot.supplyInPoolPct.toFixed(0)}%`
      }

      case 'tier3': {
        // Lowest MC, highest bar — strong signals required.
        if (score < env.MIN_DETECTOR_SCORE_TIER3) {
          return reject('tier3', 'score too low', { score, required: env.MIN_DETECTOR_SCORE_TIER3 })
        }
        if (env.REQUIRE_FRESH_DEPLOYER_TIER3 && (deployer.isSpamDeployer || deployer.tokenCount > 3)) {
          return reject('tier3', 'deployer not fresh', { deployerTokens: deployer.tokenCount })
        }
        if (snapshot.supplyInPoolPct < env.TIER3_MIN_SUPPLY_IN_POOL_PCT) {
          return reject('tier3', 'too much supply out of pool', {
            supplyInPoolPct: snapshot.supplyInPoolPct.toFixed(1),
            required: env.TIER3_MIN_SUPPLY_IN_POOL_PCT,
          })
        }
        if (snapshot.ethReserve < env.MIN_LIQUIDITY_NATIVE) {
          return reject('tier3', 'liquidity below floor', {
            ethReserve: snapshot.ethReserve.toFixed(4),
            required: env.MIN_LIQUIDITY_NATIVE,
          })
        }
        return `tier3: MC $${mcUsd.toFixed(0)}, score ${score}/${env.MIN_DETECTOR_SCORE_TIER3}, supplyInPool ${snapshot.supplyInPoolPct.toFixed(0)}%`
      }

      default:
        return null
    }
  }

  // ── Pair snapshot helper ────────────────────────────────────────────────────

  /**
   * Fetch a live snapshot of the pair: fresh reserves, market cap, and the
   * share of token supply sitting in the pool (anti-dump signal).
   * Returns null if RPC unavailable or reserves not yet live (caller decides).
   *
   * RPC-frugal: token0/token1 and decimals are IMMUTABLE and already carried on
   * the PoolCreatedEvent (the listener fetched them), so we reuse them instead
   * of re-querying the chain. That cuts this from 5 RPC calls to 2 (fresh
   * getReserves + token totalSupply). On-chain fallback only if the event
   * lacks them (legacy events).
   *
   *   MC_USD = (ethReserve / tokenReserve) × tokenTotalSupply × ETH_USD
   *   supplyInPoolPct = tokenReserve / tokenTotalSupply × 100
   */
  private async fetchPairSnapshot(
    poolAddress: string,
    tokenAddress: string,
    source: PoolCreatedEvent,
  ): Promise<PairSnapshot | null> {
    try {
      const pairContract = new Contract(poolAddress, UNISWAP_PAIR_ABI, rhProvider)

      const rawReserves = await Promise.race([
        getRawPairReserves(pairContract),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), RESERVE_FETCH_TIMEOUT_MS),
        ),
      ])
      if (!rawReserves) return null

      // Reuse immutable pair info from the event when available (no RPC).
      const wethLower = WETH_ADDRESS.toLowerCase()
      const tokenDecimals =
        source.tokenDecimals ?? (await getTokenDecimals(tokenAddress, rhProvider))

      let isToken0Eth: boolean
      if (source.token0 && source.token1) {
        isToken0Eth = source.token0.toLowerCase() === wethLower
      } else {
        const [token0, token1] = await Promise.all([
          pairContract.token0!().catch(() => null),
          pairContract.token1!().catch(() => null),
        ])
        if (token0 && token0.toLowerCase() === wethLower) isToken0Eth = true
        else if (token1 && token1.toLowerCase() === wethLower) isToken0Eth = false
        else return null // WETH not in pair — shouldn't happen (filtered upstream)
      }

      const ethReserve = isToken0Eth ? rawReserves.reserve0 : rawReserves.reserve1
      const tokenReserve = isToken0Eth ? rawReserves.reserve1 : rawReserves.reserve0
      if (tokenReserve === 0n) return null

      const totalSupplyRaw = await getTokenTotalSupply(tokenAddress, rhProvider)
      if (!totalSupplyRaw) return null

      const ethReserveNum = Number(ethReserve) / 1e18
      const tokenReserveNum = Number(tokenReserve) / 10 ** tokenDecimals
      const totalSupplyNum = Number(totalSupplyRaw) / 10 ** tokenDecimals
      if (totalSupplyNum <= 0) return null

      const FALLBACK_ETH_USD = 3000 // used only when CoinGecko cache is cold
      const ethUsdRaw = await eventBus.client.get('cache:eth_usd')
      const ethUsd = ethUsdRaw ? parseFloat(ethUsdRaw) : 0
      const effectiveEthUsd = ethUsd > 0 ? ethUsd : FALLBACK_ETH_USD
      if (ethUsd <= 0) {
        log.debug({ ethUsdRaw, fallback: FALLBACK_ETH_USD }, 'ETH/USD cache cold — using fallback price')
      }

      const priceInEth = ethReserveNum / tokenReserveNum
      const mcUsd = Math.round(priceInEth * totalSupplyNum * effectiveEthUsd)
      const supplyInPoolPct = Math.max(
        0,
        Math.min(100, (tokenReserveNum / totalSupplyNum) * 100),
      )

      return {
        mcUsd,
        ethReserve: ethReserveNum,
        tokenReserveNum,
        totalSupplyNum,
        supplyInPoolPct,
        ethUsd: effectiveEthUsd,
        rawReserve0: rawReserves.reserve0.toString(),
        rawReserve1: rawReserves.reserve1.toString(),
        rawTotalSupply: totalSupplyRaw.toString(),
      }
    } catch {
      return null
    }
  }

  // ── Age retry — re-evaluate too-young candidates instead of dropping ───────
  // The retry re-enters handleApproved, so staleness, position cap, daily loss,
  // fresh pair snapshot and honeypot checks all re-run on current state.

  private scheduleAgeRetry(
    opp: ApprovedOpportunity,
    messageId: string,
    delayMs: number,
  ): void {
    if (!this.running || this.pendingAgeRetries.has(opp.tokenAddress)) return
    log.info(
      { tokenAddress: opp.tokenAddress, delayMs, min: env.MIN_TOKEN_AGE_MS },
      'Token too young — re-evaluation scheduled at minimum age',
    )
    const timer = setTimeout(() => {
      this.pendingAgeRetries.delete(opp.tokenAddress)
      if (!this.running) return
      void this.handleApproved(opp, messageId)
    }, delayMs)
    timer.unref()
    this.pendingAgeRetries.set(opp.tokenAddress, timer)
  }

  // ── Event handler — bridge from approved stream to executor ────────────────

  private async handleApproved(
    opp: ApprovedOpportunity,
    messageId: string,
  ): Promise<void> {
    try {
      // Filter: only Uniswap protocol
      if (opp.protocol !== 'uniswap') return

      const source = opp.sourceEvent as PoolCreatedEvent
      const tokenAgeMs = Date.now() - (source.timestamp ?? opp.timestamp)
      if (tokenAgeMs < env.MIN_TOKEN_AGE_MS) {
        this.scheduleAgeRetry(
          opp,
          messageId,
          env.MIN_TOKEN_AGE_MS - tokenAgeMs + AGE_RETRY_BUFFER_MS,
        )
        return
      }

      const signal = await this.decide(opp)
      if (!signal) return

      // Publish signal for analytics/auditability
      await eventBus.publish(
        STREAMS.SIGNALS,
        signal as unknown as Record<string, unknown>,
      )

      // Fire executor inline. Failures logged inside executor, not rethrown.
      const result = await this.executor.execute(signal)

      if (result.success) {
        log.info(
          {
            tokenAddress: signal.tokenAddress,
            positionId: result.positionId,
            executionPrice: result.executionPrice.toExponential(4),
            durationMs: result.durationMs,
          },
          'Trade executed',
        )
      } else {
        log.warn(
          { tokenAddress: signal.tokenAddress, error: result.error },
          'Executor rejected signal',
        )
      }
    } catch (err) {
      log.error({ err, messageId }, 'Strategy handler failed')
    }
  }
}

export const uniswapSnipeStrategy = new UniswapSnipeStrategy({
  executor: env.TRADING_MODE === 'real' ? realExecutor : paperExecutor,
})
