import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
import { WETH_ADDRESS } from '../utils/robbinhood.utils.js'
import type { PoolCreatedEvent } from '../events/event-types.js'

const log = createChildLogger('token-analyzer')

// ── Score dimensions ──────────────────────────────────────────────────────────
// Each dimension returns 0-100; caller weights them into a composite score.
// Design: cheap checks first, expensive (HTTP fetch) gated behind cache + necessity.

// ── Redis cache keys ──────────────────────────────────────────────────────────
const META_CACHE_PREFIX = 'token:meta:'
const DEPLOYER_STATS_PREFIX = 'deployer:stats:'
const META_CACHE_TTL_S = 300 // 5 min — metadata doesn't change after deploy
const DEPLOYER_CACHE_TTL_S = 3600 // 1h — deployer stats change slowly

// ── Scam keyword patterns ─────────────────────────────────────────────────────
// Common in rug-pull tokens: hype words, celebrity names, get-rich-quick terms.
// Lowercase for case-insensitive matching.
const SCAM_BUZZWORDS = new Set([
  'pump', 'moon', '100x', '1000x', 'elon', 'pepe', 'wojak', 'chad',
  'based', 'jeet', 'wen', 'lambo', 'gem', 'ape', 'degen', 'shitcoin',
  'cumrocket', 'cum', 'ass', 'dick', 'pussy', 'cuck',
  'airdrop', 'giveaway', 'presale', 'fairlaunch',
  'v2', 'v3', 'reborn', 'revive', 'relaunch', 'migrate',
  // Common scam template words
  'official', 'real', 'legit', 'verified', 'original',
  'team', 'community', 'dao', 'defi', 'nft', 'metaverse', 'ai',
  'finance', 'capital', 'token', 'coin', 'swap', 'chain',
])

const SCAM_BUZZWORD_REGEXES = [
  /\b(100x|1000x)\b/i,
  /\b(elons?|musk)\b/i,
  /\b(pepe|wojak|chad)\b/i,
  /\b(cum|ass|dick|pussy|cuck)\b/i,
  /\b(pump\s*fun|pump\s*it)\b/i,
  /v[2-9]\b/i, // Version spam (token2, token3, etc.)
]

// ── Social link patterns ──────────────────────────────────────────────────────
const SOCIAL_PATTERNS = {
  twitter: /twitter\.com\/[A-Za-z0-9_]{1,15}|x\.com\/[A-Za-z0-9_]{1,15}/i,
  telegram: /t\.me\/[A-Za-z0-9_]{3,}|telegram\.me\/[A-Za-z0-9_]{3,}/i,
  discord: /discord\.gg\/[A-Za-z0-9]{2,}|discord\.com\/invite\/[A-Za-z0-9]{2,}/i,
  website: /https?:\/\/[^\s"'<>]+/gi,
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MetadataQuality {
  hasTwitter: boolean
  hasTelegram: boolean
  hasDiscord: boolean
  hasWebsite: boolean
  hasImage: boolean
  descriptionLength: number
  descriptionWordCount: number
  socialCount: number
  /** Raw JSON if fetch succeeded, null if unavailable */
  rawJson: Record<string, unknown> | null
  fetchError: string | null
}

export interface SymbolQuality {
  score: number // 0-100
  flags: string[]
}

export interface NameQuality {
  score: number // 0-100
  flags: string[]
}

export interface DeployerStats {
  address: string
  tokenCount: number
  firstSeenAt: number | null // epoch ms
  /** Whether this deployer was seen before */
  isKnown: boolean
  /** Whether this deployer exceeds spam thresholds */
  isSpamDeployer: boolean
}

export interface TokenAnalysis {
  metadata: MetadataQuality | null
  symbolQuality: SymbolQuality
  nameQuality: NameQuality
  deployerStats: DeployerStats
  /** Composite score 0-100 based on all weighted dimensions */
  compositeScore: number
  /** Individual dimension scores before weighting */
  dimensionScores: {
    metadata: number
    symbol: number
    name: number
    deployer: number
    initialLiquidity: number
  }
}

// ── Metadata fetcher ─────────────────────────────────────────────────────────

type FetcherFunction = (url: string, signal: AbortSignal) => Promise<string>

// Injectable fetcher — allows testing without real network
let customFetcher: FetcherFunction | null = null

export function setMetadataFetcher(fn: FetcherFunction | null): void {
  customFetcher = fn
}

/**
 * Fetch token metadata JSON from URI (IPFS or HTTP gateway).
 * Returns null on any failure — caller should treat as "no metadata".
 */
export async function fetchTokenMetadata(
  uri: string,
  timeoutMs = 3_000,
): Promise<Record<string, unknown> | null> {
  try {
    const url = normalizeUri(uri)
    if (!url) return null

    const signal = AbortSignal.timeout(timeoutMs)
    const fetcher = customFetcher ?? defaultFetcher
    const raw = await fetcher(url, signal)
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch (err) {
    log.debug({ err, uri: uri.slice(0, 80) }, 'Metadata fetch failed')
    return null
  }
}

async function defaultFetcher(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** Convert IPFS URI to HTTP gateway URL. Returns null if unparseable. */
function normalizeUri(uri: string): string | null {
  if (!uri || typeof uri !== 'string') return null
  // Already HTTP(S)
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri
  // ipfs:// → gateway
  const ipfsMatch = uri.match(/^ipfs:\/\/(.+)$/)
  if (ipfsMatch) return `https://ipfs.io/ipfs/${ipfsMatch[1]}`
  // Raw CID
  if (/^[Qm123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnopqrstuvwxyz]{46,59}$/.test(uri)) {
    return `https://ipfs.io/ipfs/${uri}`
  }
  return null
}

// ── Metadata quality analyzer ─────────────────────────────────────────────────

/** Analyze metadata JSON for quality signals. Pure function. */
export function analyzeMetadata(
  meta: Record<string, unknown> | null,
): MetadataQuality {
  if (!meta) {
    return {
      hasTwitter: false, hasTelegram: false, hasDiscord: false, hasWebsite: false,
      hasImage: false, descriptionLength: 0, descriptionWordCount: 0,
      socialCount: 0, rawJson: null, fetchError: 'no metadata json',
    }
  }

  // Flatten all string fields for link detection
  const allText = Object.values(meta)
    .filter((v): v is string => typeof v === 'string')
    .join(' ')

  const hasTwitter = SOCIAL_PATTERNS.twitter.test(allText)
  const hasTelegram = SOCIAL_PATTERNS.telegram.test(allText)
  const hasDiscord = SOCIAL_PATTERNS.discord.test(allText)
  const hasWebsite = SOCIAL_PATTERNS.website.test(allText)

  // Image detection: check common fields
  const imageUrl =
    typeof meta.image === 'string' ||
    typeof meta.logo === 'string' ||
    typeof meta.icon === 'string' ||
    typeof meta.image_url === 'string'

  // Description
  const desc = typeof meta.description === 'string' ? meta.description.trim() : ''
  const descriptionLength = desc.length
  const descriptionWordCount = desc ? desc.split(/\s+/).filter(w => w.length > 0).length : 0

  const socialCount = [hasTwitter, hasTelegram, hasDiscord].filter(Boolean).length

  return {
    hasTwitter, hasTelegram, hasDiscord,
    hasWebsite,
    hasImage: imageUrl,
    descriptionLength,
    descriptionWordCount,
    socialCount,
    rawJson: meta,
    fetchError: null,
  }
}

/** Score metadata quality 0-100. Higher = more legit-looking. */
export function scoreMetadata(meta: MetadataQuality): number {
  if (!meta.rawJson) return 0

  let score = 10 // Base for having fetchable metadata

  // Social links — strongest signal of a real project
  if (meta.hasTwitter) score += 25
  if (meta.hasTelegram) score += 15
  if (meta.hasDiscord) score += 5
  if (meta.hasWebsite) score += 10

  // Image/logo — real projects have branding
  if (meta.hasImage) score += 15

  // Description quality
  if (meta.descriptionLength >= 20) score += 5
  if (meta.descriptionLength >= 80) score += 5
  if (meta.descriptionWordCount >= 10) score += 5

  // Penalty: has socials but no image = suspicious (copied links)
  if (meta.socialCount >= 2 && !meta.hasImage) score -= 10

  return Math.max(0, Math.min(100, score))
}

// ── Symbol quality analyzer ───────────────────────────────────────────────────

/**
 * Score token symbol quality 0-100.
 * Low scores = suspicious (keyboard smash, ALL CAPS, numbers).
 * High scores = clean, readable, professional.
 */
export function analyzeSymbol(symbol: string | undefined): SymbolQuality {
  if (!symbol || symbol.length === 0) {
    return { score: 0, flags: ['missing_symbol'] }
  }

  const flags: string[] = []
  let score = 100

  // Length: <3 = suspicious, 3-5 = normal, 6-10 = fine, >10 = suspicious
  if (symbol.length < 2) { score -= 30; flags.push('symbol_too_short') }
  else if (symbol.length > 10) { score -= 15; flags.push('symbol_too_long') }

  // ALL CAPS detection — common in scam tokens
  const upperRatio = (symbol.match(/[A-Z]/g) ?? []).length / symbol.length
  if (upperRatio === 1 && symbol.length > 3) { score -= 20; flags.push('all_caps') }
  else if (upperRatio > 0.8) { score -= 10; flags.push('mostly_caps') }

  // Random numbers in symbol — "SHIB42069"
  const numberCount = (symbol.match(/\d/g) ?? []).length
  const numberRatio = numberCount / symbol.length
  if (numberRatio >= 0.5) { score -= 30; flags.push('symbol_mostly_numbers') }
  else if (numberRatio > 0.2) { score -= 15; flags.push('symbol_contains_numbers') }

  // Unicode / special chars — not real tokens
  const specialChars = (symbol.match(/[^A-Za-z0-9]/g) ?? []).length
  if (specialChars > 0) { score -= 25; flags.push('symbol_special_chars') }

  // Shannon entropy approximation: count unique chars / length
  const uniqueChars = new Set(symbol).size
  const entropyRatio = uniqueChars / symbol.length
  if (entropyRatio > 0.9 && symbol.length > 5) { score -= 20; flags.push('high_entropy_keyboard_smash') }

  // Common scam substitutions (leetspeak)
  if (/[0O]/.test(symbol) && /\d/.test(symbol)) { score -= 5; flags.push('leet_speak') }

  return { score: Math.max(0, Math.min(100, score)), flags }
}

// ── Name quality analyzer ─────────────────────────────────────────────────────

/** Score token name quality 0-100. */
export function analyzeName(name: string | undefined): NameQuality {
  if (!name || name.length === 0) {
    return { score: 0, flags: ['missing_name'] }
  }

  const flags: string[] = []
  let score = 100
  const lowerName = name.toLowerCase()

  // Length: very short (<5) or very long (>40) suspicious
  if (name.length < 3) { score -= 30; flags.push('name_too_short') }
  else if (name.length > 40) { score -= 15; flags.push('name_too_long') }

  // ALL CAPS detection
  const upperRatio = (name.match(/[A-Z]/g) ?? []).length / (name.match(/[A-Za-z]/g) ?? [' ']).length || 0
  if (upperRatio >= 0.9 && name.length > 4) { score -= 15; flags.push('all_caps_name') }

  // Scam buzzword check
  const words = lowerName.split(/[\s-]+/).filter(w => w.length > 0)
  let buzzwordCount = 0
  for (const word of words) {
    if (SCAM_BUZZWORDS.has(word)) buzzwordCount++
  }
  if (buzzwordCount >= 3) { score -= 30; flags.push('multiple_buzzwords') }
  else if (buzzwordCount >= 1 && words.length <= 3) { score -= 15; flags.push('buzzword_in_short_name') }
  else if (buzzwordCount >= 1) { score -= 5; flags.push('contains_buzzword') }

  // Buzzword regex checks (e.g. "100x", versions)
  for (const re of SCAM_BUZZWORD_REGEXES) {
    if (re.test(lowerName)) { score -= 10; flags.push('scam_pattern_match'); break }
  }

  // Spaces / word count
  if (words.length === 1 && name.length > 15) { score -= 10; flags.push('single_long_word') }
  if (words.length >= 6) { score -= 5; flags.push('too_many_words') }

  // Case analysis: MiXeD cAsE
  if (upperRatio > 0.2 && upperRatio < 0.8 && name.length > 6) {
    // mixed case is normal (e.g. "DogWifHat")
  }
  // All lowercase with spaces = less professional but not necessarily scam

  return { score: Math.max(0, Math.min(100, score)), flags }
}

// ── Deployer history tracker ──────────────────────────────────────────────────

interface DeployerRecord {
  tokenCount: number
  firstSeenAt: number
  lastSeenAt: number
  tokens: string[] // last N token addresses
}

/**
 * Track deployer activity in Redis.
 * - Increments token count for the deployer
 * - Records token addresses deployed (limited to last 20)
 * - Returns stats for scoring
 */
export async function trackDeployer(
  deployerAddress: string,
  tokenAddress: string,
  now: number = Date.now(),
): Promise<DeployerStats> {
  const key = `${DEPLOYER_STATS_PREFIX}${deployerAddress}`
  const redis = eventBus.client

  try {
    const raw = await redis.get(key)
    let record: DeployerRecord

    if (raw) {
      record = JSON.parse(raw) as DeployerRecord
      record.tokenCount++
      record.lastSeenAt = now
      // Keep last 20 tokens, prepend new one
      record.tokens = [tokenAddress, ...(record.tokens ?? []).slice(0, 19)]
    } else {
      record = {
        tokenCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        tokens: [tokenAddress],
      }
    }

    await redis.set(key, JSON.stringify(record), 'EX', DEPLOYER_CACHE_TTL_S)

    return {
      address: deployerAddress,
      tokenCount: record.tokenCount,
      firstSeenAt: record.firstSeenAt,
      isKnown: record.tokenCount > 1,
      isSpamDeployer: record.tokenCount > 10, // >10 tokens = likely spam factory
    }
  } catch (err) {
    log.debug({ err, deployerAddress: deployerAddress.slice(0, 12) }, 'Deployer tracking failed')
    // Fail-open: unknown deployer with no penalty
    return {
      address: deployerAddress,
      tokenCount: 0,
      firstSeenAt: null,
      isKnown: false,
      isSpamDeployer: false,
    }
  }
}

/**
 * Score deployer 0-100. Higher = more trustworthy.
 * New deployers get neutral score (50) — we don't penalize first-timers.
 * Repeat deployers with good history get higher scores.
 * Serial deployers get penalized.
 */
export function scoreDeployer(stats: DeployerStats): number {
  // New deployer — neutral (neither penalty nor bonus)
  if (!stats.isKnown || stats.tokenCount === 1) return 50

  // Serial deployer factory — heavy penalty
  if (stats.isSpamDeployer) return 0
  if (stats.tokenCount > 5) return 15
  if (stats.tokenCount > 3) return 30

  // Repeat deployer (2-3 tokens) — moderate penalty
  return 40
}

// ── Initial liquidity scoring ──────────────────────────────────────────────────

/**
 * Score the deployer's "skin in the game" 0-100 based on initial ETH liquidity.
 * For Uniswap V2, the deployer provides real liquidity to the pair at creation.
 *
 * Reference: typical Uniswap V2 initial liquidity ranges from 0.1 to 10+ ETH.
 *   0.1 ETH   = minimum (~$200)
 *   0.5 ETH   = meaningful (~$1,000)
 *   3 ETH     = strong commitment (~$6,000)
 */
export function scoreInitialLiquidity(liquidityNative: number): number {
  if (liquidityNative <= 0) return 0
  if (liquidityNative < 0.05) return 5    // Near-zero liquidity = pure scam
  if (liquidityNative < 0.1) return 15    // Bare minimum effort
  if (liquidityNative < 0.3) return 30    // Low liquidity
  if (liquidityNative < 0.5) return 50    // Moderate
  if (liquidityNative < 1.0) return 70    // Decent commitment
  if (liquidityNative < 3.0) return 85    // Strong commitment
  return 100                                // Very strong
}

// ── Cached metadata fetch ─────────────────────────────────────────────────────

/**
 * Fetch + cache metadata JSON via Redis.
 * Subsequent calls for the same URI within TTL return cached result.
 */
export async function getCachedMetadata(
  uri: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!uri) return null

  const cacheKey = `${META_CACHE_PREFIX}${hashString(uri)}`
  const redis = eventBus.client

  try {
    const cached = await redis.get(cacheKey)
    if (cached !== null) {
      return JSON.parse(cached) as Record<string, unknown>
    }
  } catch {
    // Redis error → proceed to fetch
  }

  const meta = await fetchTokenMetadata(uri)

  // Cache result (even null — avoids re-fetching broken URIs)
  try {
    await redis.set(cacheKey, JSON.stringify(meta ?? null), 'EX', META_CACHE_TTL_S)
  } catch {
    // non-fatal
  }

  return meta
}

// ── Full analysis — convenience method ────────────────────────────────────────

/**
 * Run full token analysis pipeline:
 * 1. Fetch metadata from URI
 * 2. Analyze symbol + name quality
 * 3. Track deployer history
 * 4. Score dev buy
 * 5. Return composite with weighted dimensions
 */
export async function analyzeToken(
  event: PoolCreatedEvent,
): Promise<TokenAnalysis> {
  const md = event.tokenMetadata

  // 1. Metadata fetch + analysis
  let metadata: MetadataQuality | null = null
  let metadataScore = 0
  if (md?.uri) {
    const raw = await getCachedMetadata(md.uri)
    metadata = analyzeMetadata(raw)
    metadataScore = scoreMetadata(metadata)
  } else {
    metadata = analyzeMetadata(null)
  }

  // 2. Symbol quality
  const symbolQuality = analyzeSymbol(md?.symbol)

  // 3. Name quality
  const nameQuality = analyzeName(md?.name)

  // 4. Deployer tracking
  const deployerStats = await trackDeployer(
    event.deployerAddress,
    event.tokenAddress,
  )
  const deployerScore = scoreDeployer(deployerStats)

  // 5. Initial liquidity (replaces Pump.fun dev-buy) — derived from pair reserves
  const initialLiquidityNative = computeInitialLiquidity(event)
  const initialLiquidityScore = scoreInitialLiquidity(initialLiquidityNative)

  // Composite: weighted average over the dimensions that actually exist.
  //
  // Plain ERC-20s on Uniswap V2 have NO metadata URI (that dimension came from
  // Pump.fun/Solana), so weighting it statically zeroed 35% of the score and
  // made Tier 2/3 thresholds mathematically unreachable. Weights are now
  // dynamic: metadata only participates when a URI is present, otherwise its
  // weight is redistributed so the composite spans the full 0-100 range.
  //
  //   With URI:    metadata 35%, symbol 10%, name 15%, deployer 25%, liquidity 15%
  //   Without URI: symbol 15%, name 20%, deployer 35%, liquidity 30%
  //     - Deployer: serial deployers = almost guaranteed scam
  //     - Initial liquidity: the deployer's real skin-in-the-game on Uniswap V2
  const hasMetadataUri = Boolean(md?.uri)
  const compositeScore = hasMetadataUri
    ? Math.round(
        metadataScore * 0.35 +
        symbolQuality.score * 0.10 +
        nameQuality.score * 0.15 +
        deployerScore * 0.25 +
        initialLiquidityScore * 0.15,
      )
    : Math.round(
        symbolQuality.score * 0.15 +
        nameQuality.score * 0.20 +
        deployerScore * 0.35 +
        initialLiquidityScore * 0.30,
      )

  return {
    metadata,
    symbolQuality,
    nameQuality,
    deployerStats,
    compositeScore,
    dimensionScores: {
      metadata: metadataScore,
      symbol: symbolQuality.score,
      name: nameQuality.score,
      deployer: deployerScore,
      initialLiquidity: initialLiquidityScore,
    },
  }
}

/**
 * Compute initial ETH liquidity from a PoolCreatedEvent's pair reserves.
 * Determines which reserve is WETH and converts the raw wei string to native units.
 */
function computeInitialLiquidity(event: PoolCreatedEvent): number {
  const r0 = event.reserve0
  const r1 = event.reserve1
  if (!r0 || !r1) return 0

  const wethLower = WETH_ADDRESS.toLowerCase()
  const t0 = event.token0?.toLowerCase()
  const t1 = event.token1?.toLowerCase()

  try {
    if (t0 === wethLower) {
      return parseFloat(r0) / 1e18
    } else if (t1 === wethLower) {
      return parseFloat(r1) / 1e18
    }
  } catch {
    // parseFloat failure on malformed reserve string
  }
  return 0
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fast non-crypto hash of string for cache keys */
function hashString(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    hash = ((hash << 5) - hash) + ch
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

/** String similarity via Levenshtein distance (normalized 0-1, lower = more similar) */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const lenA = a.length
  const lenB = b.length
  const maxLen = Math.max(lenA, lenB)

  // Use simple Levenshtein
  // Initialize full matrix to avoid "possibly undefined" index access
  const matrix: number[][] = Array.from({ length: lenA + 1 }, () => new Array<number>(lenB + 1).fill(0))
  for (let i = 0; i <= lenA; i++) {
    matrix[i]![0] = i
  }
  for (let j = 0; j <= lenB; j++) {
    matrix[0]![j] = j
  }
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      )
    }
  }

  const distance = matrix[lenA]![lenB]!
  return 1 - distance / maxLen
}

/**
 * Normalize symbol for fuzzy comparison:
 * - lowercase
 * - replace common leet substitutions (0→o, 1→l, 3→e, 4→a, 5→s, $→s, @→a)
 * - strip non-alphanumeric
 */
export function normalizeSymbol(s: string): string {
  return s
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/\$/g, 's')
    .replace(/@/g, 'a')
    .replace(/7/g, 't')
    .replace(/[^a-z0-9]/g, '')
}
