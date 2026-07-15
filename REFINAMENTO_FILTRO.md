# Refinamento do Filtro do Bot Sniper PumpFun

> Documento para replicação das alterações por outra IA ou desenvolvedor.
> Data: 2026-07-02
> Branch/Código base: `solana-memecoin-bot-main`

---

## Motivação

O bot sniper original usava um filtro **binário** baseado apenas em `MIN_ENTRY_MC_USD` (default $6k). Isso causava dois problemas:
- **Mantendo $6k**: Muito conservador — não pegava entradas boas
- **Baixando para $4k**: Pegava muitos rug pulls (moedas que o deployer abandona em 15 minutos)

O filtro não tinha inteligência para distinguir um projeto legítimo de um scam, porque ignorava completamente: qualidade do metadata (redes sociais, logo, descrição), qualidade do nome/símbolo (keyboard smash, ALL CAPS, buzzwords), histórico do deployer (serial scammer vs primeira vez), e momentum de compra.

**Objetivo**: Substituir o threshold binário por um sistema de scoring multi-dimensional com tiers progressivos.

---

## Arquitetura do Bot (Antes)

```
PumpPortal WS Listener
    ↓ (events:raw)
Parser (pumpfun.parser.ts)
    ↓ (events:parsed)
Detector (pumpfun-launch.detector.ts)
    ↓ (events:candidates)
Risk Engine (risk-engine.ts) → checks: liquidity, blacklist, mint-freeze
    ↓ (events:approved)
Strategy (pumpfun-snipe.strategy.ts) → gate: MIN_ENTRY_MC_USD binário
    ↓ (events:signals)
Executor (paper ou real)
```

---

## Resumo das Alterações

| # | Arquivo | Tipo | Descrição |
|---|---------|------|-----------|
| 1 | `src/analysis/token-analyzer.ts` | **NOVO** | Motor de análise de qualidade do token |
| 2 | `src/config/env.ts` | **MODIFICADO** | 11 novos parâmetros de configuração |
| 3 | `src/detectors/pumpfun-launch.detector.ts` | **REESCRITO** | Scoring multi-dimensional + spam detection fuzzy |
| 4 | `src/strategies/pumpfun-snipe.strategy.ts` | **REESCRITO** | Sistema de 3 tiers substituindo threshold binário |
| 5 | `src/risk/checks/token-quality.check.ts` | **NOVO** | Check rápido de qualidade no risk-engine |
| 6 | `src/risk/risk-engine.ts` | **MODIFICADO** | Adiciona TokenQualityCheck à pipeline |

---

## 1. `src/analysis/token-analyzer.ts` (NOVO — criar arquivo)

### O que é
Motor central de análise de qualidade. Contém funções puras (sem side effects) e funções com cache Redis. Pode ser usado tanto no detector (fast path, sem I/O) quanto na strategy (slow path, com fetch HTTP).

### Funções exportadas

#### `fetchTokenMetadata(uri: string, timeoutMs?: number): Promise<Record<string, unknown> | null>`
Busca o JSON de metadata do token via HTTP/IPFS. Converte URIs `ipfs://` automaticamente para `https://ipfs.io/ipfs/`.

#### `analyzeMetadata(meta: Record<string, unknown> | null): MetadataQuality`
Analisa o JSON de metadata e extrai:
- `hasTwitter`, `hasTelegram`, `hasDiscord` — presença de links de redes sociais
- `hasWebsite` — presença de website
- `hasImage` — presença de logo/imagem (campos `image`, `logo`, `icon`, `image_url`)
- `descriptionLength`, `descriptionWordCount` — qualidade da descrição
- `socialCount` — contagem de redes sociais encontradas

#### `scoreMetadata(meta: MetadataQuality): number` (0-100)
Converte MetadataQuality em score:
- Base 10 (ter metadata fetchable)
- +25 Twitter, +15 Telegram, +5 Discord, +10 Website
- +15 Logo/Imagem
- +5/+5 descrição de 20/80+ caracteres
- Penalidade -10 se tem redes sociais mas sem imagem (suspeito)

#### `analyzeSymbol(symbol: string | undefined): SymbolQuality`
Analisa qualidade do símbolo do token. Detecta:
- **ALL_CAPS**: 100% maiúsculas com mais de 3 caracteres → -20
- **Keyboard smash**: alta entropia de caracteres únicos → -20
- **Números**: >50% números → -30, >20% → -15
- **Caracteres especiais**: não [A-Za-z0-9] → -25
- **Leet speak**: substituições comuns (0→O) → -5
- **Comprimento**: <2 chars → -30, >10 chars → -15

#### `analyzeName(name: string | undefined): NameQuality`
Analisa qualidade do nome do token. Detecta:
- **Buzzwords scam**: palavras como "pump", "moon", "100x", "elon", "pepe", "wen", "lambo", "gem", "ape", "v2", "v3", "official", "real", "verified" etc.
- **ALL CAPS**: 90%+ maiúsculas → -15
- **Scam regex patterns**: `/\b(100x|1000x)\b/i`, `/\b(elons?|musk)\b/i`, `/v[2-9]\b/i` etc.
- **Comprimento anormal**: <3 chars → -30, >40 chars → -15
- **Palavra única longa**: >15 chars sem espaços → -10

#### `trackDeployer(deployerAddress, tokenAddress, now?): Promise<DeployerStats>`
Rastreia atividade do deployer no Redis (TTL 1h):
- Conta quantos tokens o wallet já criou
- Registra primeiro/último deploy
- Mantém lista dos últimos 20 tokens
- Retorna `isSpamDeployer: true` se >10 tokens

#### `scoreDeployer(stats: DeployerStats): number` (0-100)
- Novo deployer (1 token) → 50 (neutro)
- 2-3 tokens → 40
- 4-5 tokens → 30
- 6-10 tokens → 15
- >10 tokens (spam factory) → 0

#### `scoreDevBuy(devBuySol: number): number` (0-100)
Mais SOL investido pelo criador = mais comprometimento:
- 0 SOL → 0
- <0.05 SOL → 5
- <0.1 SOL → 15
- <0.3 SOL → 30
- <0.5 SOL → 50
- <1.0 SOL → 70
- <2.0 SOL → 85
- ≥2.0 SOL → 100

#### `analyzeToken(event: PoolCreatedEvent): Promise<TokenAnalysis>`
Pipeline completo de análise:
1. Busca metadata da URI (com cache Redis 5min)
2. Analisa símbolo + nome
3. Rastreia histórico do deployer
4. Pontua dev buy
5. Calcula **compositeScore** com pesos: metadata 35%, symbol 10%, name 15%, deployer 25%, dev buy 15%

#### `stringSimilarity(a: string, b: string): number` (0-1)
Distância Levenshtein normalizada. Usada no fuzzy symbol matching.

#### `normalizeSymbol(s: string): string`
Normaliza símbolo para comparação fuzzy: lowercase + substitui leet chars (0→o, 1→l, 3→e, 4→a, 5→s, $→s, @→a, 7→t) + remove não-alfanuméricos.

#### `getCachedMetadata(uri: string | undefined): Promise<Record<string, unknown> | null>`
Wrapper com cache Redis para fetchTokenMetadata. TTL 5 minutos.

### Cache Redis
- `token:meta:{hash}` — metadata JSON cacheado, TTL 300s
- `deployer:stats:{address}` — estatísticas do deployer, TTL 3600s

### Dependências
```typescript
import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
import type { PoolCreatedEvent } from '../events/event-types.js'
```

### Conteúdo completo do arquivo
```typescript
import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
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
  /v[2-9]\b/i,
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
  rawJson: Record<string, unknown> | null
  fetchError: string | null
}

export interface SymbolQuality {
  score: number
  flags: string[]
}

export interface NameQuality {
  score: number
  flags: string[]
}

export interface DeployerStats {
  address: string
  tokenCount: number
  firstSeenAt: number | null
  isKnown: boolean
  isSpamDeployer: boolean
}

export interface TokenAnalysis {
  metadata: MetadataQuality | null
  symbolQuality: SymbolQuality
  nameQuality: NameQuality
  deployerStats: DeployerStats
  compositeScore: number
  dimensionScores: {
    metadata: number
    symbol: number
    name: number
    deployer: number
    devBuy: number
  }
}

// ── Metadata fetcher ─────────────────────────────────────────────────────────

type FetcherFunction = (url: string, signal: AbortSignal) => Promise<string>
let customFetcher: FetcherFunction | null = null

export function setMetadataFetcher(fn: FetcherFunction | null): void {
  customFetcher = fn
}

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

function normalizeUri(uri: string): string | null {
  if (!uri || typeof uri !== 'string') return null
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri
  const ipfsMatch = uri.match(/^ipfs:\/\/(.+)$/)
  if (ipfsMatch) return `https://ipfs.io/ipfs/${ipfsMatch[1]}`
  if (/^[Qm123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnopqrstuvwxyz]{46,59}$/.test(uri)) {
    return `https://ipfs.io/ipfs/${uri}`
  }
  return null
}

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

  const allText = Object.values(meta)
    .filter((v): v is string => typeof v === 'string')
    .join(' ')

  const hasTwitter = SOCIAL_PATTERNS.twitter.test(allText)
  const hasTelegram = SOCIAL_PATTERNS.telegram.test(allText)
  const hasDiscord = SOCIAL_PATTERNS.discord.test(allText)
  const hasWebsite = SOCIAL_PATTERNS.website.test(allText)

  const imageUrl =
    typeof meta.image === 'string' ||
    typeof meta.logo === 'string' ||
    typeof meta.icon === 'string' ||
    typeof meta.image_url === 'string'

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

export function scoreMetadata(meta: MetadataQuality): number {
  if (!meta.rawJson) return 0
  let score = 10
  if (meta.hasTwitter) score += 25
  if (meta.hasTelegram) score += 15
  if (meta.hasDiscord) score += 5
  if (meta.hasWebsite) score += 10
  if (meta.hasImage) score += 15
  if (meta.descriptionLength >= 20) score += 5
  if (meta.descriptionLength >= 80) score += 5
  if (meta.descriptionWordCount >= 10) score += 5
  if (meta.socialCount >= 2 && !meta.hasImage) score -= 10
  return Math.max(0, Math.min(100, score))
}

export function analyzeSymbol(symbol: string | undefined): SymbolQuality {
  if (!symbol || symbol.length === 0) {
    return { score: 0, flags: ['missing_symbol'] }
  }
  const flags: string[] = []
  let score = 100
  if (symbol.length < 2) { score -= 30; flags.push('symbol_too_short') }
  else if (symbol.length > 10) { score -= 15; flags.push('symbol_too_long') }
  const upperRatio = (symbol.match(/[A-Z]/g) ?? []).length / symbol.length
  if (upperRatio === 1 && symbol.length > 3) { score -= 20; flags.push('all_caps') }
  else if (upperRatio > 0.8) { score -= 10; flags.push('mostly_caps') }
  const numberCount = (symbol.match(/\d/g) ?? []).length
  const numberRatio = numberCount / symbol.length
  if (numberRatio >= 0.5) { score -= 30; flags.push('symbol_mostly_numbers') }
  else if (numberRatio > 0.2) { score -= 15; flags.push('symbol_contains_numbers') }
  const specialChars = (symbol.match(/[^A-Za-z0-9]/g) ?? []).length
  if (specialChars > 0) { score -= 25; flags.push('symbol_special_chars') }
  const uniqueChars = new Set(symbol).size
  const entropyRatio = uniqueChars / symbol.length
  if (entropyRatio > 0.9 && symbol.length > 5) { score -= 20; flags.push('high_entropy_keyboard_smash') }
  if (/[0O]/.test(symbol) && /\d/.test(symbol)) { score -= 5; flags.push('leet_speak') }
  return { score: Math.max(0, Math.min(100, score)), flags }
}

export function analyzeName(name: string | undefined): NameQuality {
  if (!name || name.length === 0) {
    return { score: 0, flags: ['missing_name'] }
  }
  const flags: string[] = []
  let score = 100
  const lowerName = name.toLowerCase()
  if (name.length < 3) { score -= 30; flags.push('name_too_short') }
  else if (name.length > 40) { score -= 15; flags.push('name_too_long') }
  const upperRatio = (name.match(/[A-Z]/g) ?? []).length / (name.match(/[A-Za-z]/g) ?? [' ']).length || 0
  if (upperRatio >= 0.9 && name.length > 4) { score -= 15; flags.push('all_caps_name') }
  const words = lowerName.split(/[\s-]+/).filter(w => w.length > 0)
  let buzzwordCount = 0
  for (const word of words) {
    if (SCAM_BUZZWORDS.has(word)) buzzwordCount++
  }
  if (buzzwordCount >= 3) { score -= 30; flags.push('multiple_buzzwords') }
  else if (buzzwordCount >= 1 && words.length <= 3) { score -= 15; flags.push('buzzword_in_short_name') }
  else if (buzzwordCount >= 1) { score -= 5; flags.push('contains_buzzword') }
  for (const re of SCAM_BUZZWORD_REGEXES) {
    if (re.test(lowerName)) { score -= 10; flags.push('scam_pattern_match'); break }
  }
  if (words.length === 1 && name.length > 15) { score -= 10; flags.push('single_long_word') }
  if (words.length >= 6) { score -= 5; flags.push('too_many_words') }
  return { score: Math.max(0, Math.min(100, score)), flags }
}

export async function trackDeployer(
  deployerAddress: string,
  tokenAddress: string,
  now: number = Date.now(),
): Promise<DeployerStats> {
  const key = `${DEPLOYER_STATS_PREFIX}${deployerAddress}`
  const redis = eventBus.client
  try {
    const raw = await redis.get(key)
    interface DeployerRecord {
      tokenCount: number
      firstSeenAt: number
      lastSeenAt: number
      tokens: string[]
    }
    let record: DeployerRecord
    if (raw) {
      record = JSON.parse(raw) as DeployerRecord
      record.tokenCount++
      record.lastSeenAt = now
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
      isSpamDeployer: record.tokenCount > 10,
    }
  } catch (err) {
    log.debug({ err, deployerAddress: deployerAddress.slice(0, 12) }, 'Deployer tracking failed')
    return {
      address: deployerAddress,
      tokenCount: 0,
      firstSeenAt: null,
      isKnown: false,
      isSpamDeployer: false,
    }
  }
}

export function scoreDeployer(stats: DeployerStats): number {
  if (!stats.isKnown || stats.tokenCount === 1) return 50
  if (stats.isSpamDeployer) return 0
  if (stats.tokenCount > 5) return 15
  if (stats.tokenCount > 3) return 30
  return 40
}

export function scoreDevBuy(devBuySol: number): number {
  if (devBuySol <= 0) return 0
  if (devBuySol < 0.05) return 5
  if (devBuySol < 0.1) return 15
  if (devBuySol < 0.3) return 30
  if (devBuySol < 0.5) return 50
  if (devBuySol < 1.0) return 70
  if (devBuySol < 2.0) return 85
  return 100
}

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
  try {
    await redis.set(cacheKey, JSON.stringify(meta ?? null), 'EX', META_CACHE_TTL_S)
  } catch {
    // non-fatal
  }
  return meta
}

export async function analyzeToken(
  event: PoolCreatedEvent,
): Promise<TokenAnalysis> {
  const md = event.tokenMetadata

  let metadata: MetadataQuality | null = null
  let metadataScore = 0
  if (md?.uri) {
    const raw = await getCachedMetadata(md.uri)
    metadata = analyzeMetadata(raw)
    metadataScore = scoreMetadata(metadata)
  } else {
    metadata = analyzeMetadata(null)
  }

  const symbolQuality = analyzeSymbol(md?.symbol)
  const nameQuality = analyzeName(md?.name)
  const deployerStats = await trackDeployer(
    event.deployerAddress,
    event.tokenAddress,
  )
  const deployerScore = scoreDeployer(deployerStats)
  const devBuyScore = scoreDevBuy(event.initialBuySol ?? 0)

  const compositeScore = Math.round(
    metadataScore * 0.35 +
    symbolQuality.score * 0.10 +
    nameQuality.score * 0.15 +
    deployerScore * 0.25 +
    devBuyScore * 0.15,
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
      devBuy: devBuyScore,
    },
  }
}

function hashString(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    hash = ((hash << 5) - hash) + ch
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const lenA = a.length
  const lenB = b.length
  const maxLen = Math.max(lenA, lenB)
  const matrix: number[][] = []
  for (let i = 0; i <= lenA; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= lenB; j++) {
    matrix[0][j] = j
  }
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      )
    }
  }
  const distance = matrix[lenA][lenB]
  return 1 - distance / maxLen
}

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
```

---

## 2. `src/config/env.ts` (MODIFICADO)

### Alteração
Encontrar o bloco:
```typescript
  /** Minimum market cap at entry (USD). Requires token to have pumped above launch floor. */
  MIN_ENTRY_MC_USD: z.coerce.number().nonnegative().default(6_000),
```

Substituir por:
```typescript
  // ── Multi-tier entry filter ──────────────────────────────────────────────────
  /** Absolute floor market cap (USD). Tokens below this are ALWAYS rejected. */
  MIN_ENTRY_MC_USD: z.coerce.number().nonnegative().default(2_000),
  /** Tier 1 threshold (USD). MC ≥ this: easiest entry requirements. */
  TIER1_MC_USD: z.coerce.number().positive().default(8_000),
  /** Tier 2 threshold (USD). MC ≥ this: moderate entry requirements. */
  TIER2_MC_USD: z.coerce.number().positive().default(5_000),
  /** Minimum detector score for Tier 1 (high MC, low bar). */
  MIN_DETECTOR_SCORE: z.coerce.number().int().min(0).max(100).default(35),
  /** Minimum detector score for Tier 2 (medium MC, medium bar). */
  MIN_DETECTOR_SCORE_TIER2: z.coerce.number().int().min(0).max(100).default(55),
  /** Minimum detector score for Tier 3 (low MC, high bar — requires strong signals). */
  MIN_DETECTOR_SCORE_TIER3: z.coerce.number().int().min(0).max(100).default(75),
  /** Require social links (Twitter/Telegram) for Tier 2 and below. */
  REQUIRE_SOCIAL_TIER2: z.coerce.boolean().default(true),
  /** Require deployer to be first-timer for Tier 3 (low MC). */
  REQUIRE_FRESH_DEPLOYER_TIER3: z.coerce.boolean().default(true),
  /** Minimum token age (ms) before entry — prevents instant rug where deployer pulls in <5s. */
  MIN_TOKEN_AGE_MS: z.coerce.number().int().nonnegative().default(3_000),
  /** Minimum dev buy (SOL) for deployer commitment — overrides detector's default. */
  MIN_DEV_BUY_SOL: z.coerce.number().nonnegative().default(0.05),
```

### Novos parâmetros `.env` (adicionar ao `.env`)
```bash
# Multi-tier entry filter
MIN_ENTRY_MC_USD=2000
TIER1_MC_USD=8000
TIER2_MC_USD=5000
MIN_DETECTOR_SCORE=35
MIN_DETECTOR_SCORE_TIER2=55
MIN_DETECTOR_SCORE_TIER3=75
REQUIRE_SOCIAL_TIER2=true
REQUIRE_FRESH_DEPLOYER_TIER3=true
MIN_TOKEN_AGE_MS=3000
MIN_DEV_BUY_SOL=0.05
```

---

## 3. `src/detectors/pumpfun-launch.detector.ts` (REESCRITO — substituir arquivo inteiro)

### O que mudou
- **`evaluate()`** agora é `async` (para integrar com o trackDeployer)
- **`scoreLaunch()`** substituído por scoring multi-dimensional: symbol (25%), name (15%), metadata signals (20%), dev buy (20%), deployer burst (20%)
- **`isFuzzySymbolSpam()`** NOVO — detecta clusters de spam com símbolos similares (Levenshtein distance + normalização leet-speak)
- **`isDeployerBurst()`** NOVO — detecta serial deployers (5+ tokens em 5 minutos)
- **Score mínimo gate**: rejeita tokens com composite score < 15
- **Imports adicionados**: `analyzeSymbol`, `analyzeName`, `scoreDeployer`, `scoreDevBuy`, `stringSimilarity`, `normalizeSymbol` de `../analysis/token-analyzer.js`

### Conteúdo completo do arquivo
```typescript
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
  scoreDevBuy,
  stringSimilarity,
  normalizeSymbol,
} from '../analysis/token-analyzer.js'

const log = createChildLogger('pumpfun-launch-detector')

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const MIN_INITIAL_BUY_SOL = 0.05

const FUZZY_SYMBOL_WINDOW_MS = 120_000
const FUZZY_SYMBOL_THRESHOLD = 0.8
const DEPLOYER_BURST_MAX = 5
const DEPLOYER_BURST_WINDOW_MS = 300_000

interface DetectorOptions {
  blockMs?: number
  count?: number
  consumerGroup?: string
  maxAgeMs?: number
}

export class PumpFunLaunchDetector {
  private running = false
  private readonly blockMs: number
  private readonly count: number
  private readonly consumerGroup: string
  private readonly maxAgeMs: number

  private readonly seenTokens = new Map<string, number>()
  private readonly seenTokensMax = 5_000
  private readonly seenTokensTtlMs = 60 * 60 * 1_000

  private readonly recentMetadata = new Map<string, number>()
  private readonly spamWindowMs = 60_000
  private readonly recentMetadataMax = 2_000

  // NOVO: Fuzzy symbol matching
  private readonly fuzzySymbolCache = new Map<string, {
    count: number
    firstSeenAt: number
    lastSeenAt: number
    symbols: Set<string>
  }>()
  private readonly fuzzySymbolCacheMax = 3_000

  // NOVO: Deployer burst tracking
  private readonly deployerBurstCache = new Map<string, {
    count: number
    firstSeenAt: number
    lastSeenAt: number
  }>()
  private readonly deployerBurstCacheMax = 2_000

  constructor(options: DetectorOptions = {}) {
    this.blockMs = options.blockMs ?? 2_000
    this.count = options.count ?? 20
    this.consumerGroup = options.consumerGroup ?? 'pumpfun-launch-detector'
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
      'PumpFunLaunchDetector subscribed (enhanced multi-dimension scoring)',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    this.seenTokens.clear()
    this.recentMetadata.clear()
    this.fuzzySymbolCache.clear()
    this.deployerBurstCache.clear()
    log.info('PumpFunLaunchDetector stopped')
  }

  private async handleParsedEvent(
    data: Record<string, unknown>,
    messageId: string,
  ): Promise<void> {
    const event = data as unknown as ParsedEvent
    if (event.protocol !== 'pumpfun') return
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

  private async evaluate(event: PoolCreatedEvent): Promise<CandidateOpportunity | null> {
    const {
      tokenAddress,
      poolAddress,
      deployerAddress,
      initialLiquiditySol,
      timestamp,
    } = event

    if (!isValidSolanaAddress(tokenAddress)) {
      log.debug({ tokenAddress }, 'Invalid token address — discard')
      return null
    }
    if (!isValidSolanaAddress(poolAddress)) {
      log.debug({ poolAddress }, 'Invalid pool address — discard')
      return null
    }
    if (!isValidSolanaAddress(deployerAddress)) {
      log.debug({ deployerAddress }, 'Invalid deployer address — discard')
      return null
    }

    const ageMs = Date.now() - timestamp
    if (ageMs > this.maxAgeMs) {
      log.debug({ tokenAddress, ageMs, maxAgeMs: this.maxAgeMs }, 'Event too old — discard')
      return null
    }

    if (this.isDuplicate(tokenAddress)) {
      log.debug({ tokenAddress }, 'Duplicate token — discard')
      return null
    }
    this.recordSeen(tokenAddress)

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

    if (this.isFuzzySymbolSpam(event)) {
      log.warn(
        { tokenAddress, symbol: event.tokenMetadata?.symbol },
        'FUZZY SYMBOL SPAM — similar symbol deployed recently, rejecting',
      )
      return null
    }

    if (this.isDeployerBurst(deployerAddress)) {
      log.warn(
        { tokenAddress, deployerAddress: deployerAddress.slice(0, 12) },
        'DEPLOYER BURST — serial deployer detected, rejecting',
      )
      return null
    }

    const devBuySol = event.initialBuySol ?? 0
    if (devBuySol < MIN_INITIAL_BUY_SOL) {
      log.debug(
        { tokenAddress, devBuySol, required: MIN_INITIAL_BUY_SOL },
        'Dev buy too low — discard',
      )
      return null
    }

    if (initialLiquiditySol <= 0) {
      log.debug({ tokenAddress, initialLiquiditySol }, 'Zero liquidity — discard')
      return null
    }

    const score = await this.scoreLaunch(event)

    if (score < 15) {
      log.debug({ tokenAddress, score }, 'Composite score too low — discard')
      return null
    }

    const candidate: CandidateOpportunity = {
      candidateId: randomUUID(),
      timestamp: Date.now(),
      protocol: 'pumpfun',
      tokenAddress,
      poolAddress,
      deployerAddress,
      initialLiquiditySol,
      detectorScore: score,
      sourceEvent: event,
    }
    return candidate
  }

  private async scoreLaunch(event: PoolCreatedEvent): Promise<number> {
    const md = event.tokenMetadata

    const symResult = analyzeSymbol(md?.symbol)
    const symScore = symResult.score
    if (symResult.flags.length > 0) {
      log.debug(
        { symbol: md?.symbol, score: symScore, flags: symResult.flags },
        'Symbol quality analysis',
      )
    }

    const nameResult = analyzeName(md?.name)
    const nameScore = nameResult.score
    if (nameResult.flags.length > 0) {
      log.debug(
        { name: md?.name?.slice(0, 40), score: nameScore, flags: nameResult.flags },
        'Name quality analysis',
      )
    }

    let metaScore = 0
    if (md?.uri && md.uri.length > 0) metaScore += 30
    if (md?.uri && (md.uri.startsWith('https://') || md.uri.startsWith('ipfs://'))) metaScore += 20
    if (md?.name && md.name.length >= 3 && md.name.length <= 32) metaScore += 15
    if (md?.symbol && md.symbol.length >= 2 && md.symbol.length <= 10) metaScore += 15
    if (md?.name && md?.symbol && md?.uri) metaScore += 20

    const devBuyScore = scoreDevBuy(event.initialBuySol ?? 0)

    const burstInfo = this.deployerBurstCache.get(event.deployerAddress)
    let deployerScore = 50
    if (burstInfo && burstInfo.count > 1) {
      if (burstInfo.count >= DEPLOYER_BURST_MAX) deployerScore = 0
      else if (burstInfo.count > 3) deployerScore = 15
      else if (burstInfo.count > 1) deployerScore = 30
    }

    const composite = Math.round(
      symScore * 0.25 +
      nameScore * 0.15 +
      metaScore * 0.20 +
      devBuyScore * 0.20 +
      deployerScore * 0.20,
    )

    log.debug(
      {
        token: md?.symbol ?? event.tokenAddress.slice(0, 10),
        symScore, nameScore, metaScore, devBuyScore, deployerScore, composite,
      },
      'Launch multi-dimension score',
    )

    return Math.max(0, Math.min(100, composite))
  }

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

  private isSpamPattern(event: PoolCreatedEvent): boolean {
    const md = event.tokenMetadata
    const symbol = md?.symbol?.trim()
    const name = md?.name?.trim()
    if (!symbol && !name) return false
    const key = `${symbol ?? ''}::${name ?? ''}`
    const now = Date.now()
    const lastSeen = this.recentMetadata.get(key)
    if (this.recentMetadata.size >= this.recentMetadataMax) {
      for (const [k, ts] of this.recentMetadata) {
        if (now - ts > this.spamWindowMs) this.recentMetadata.delete(k)
      }
    }
    this.recentMetadata.set(key, now)
    return lastSeen !== undefined && now - lastSeen < this.spamWindowMs
  }

  // NOVO: Fuzzy symbol spam detection
  private isFuzzySymbolSpam(event: PoolCreatedEvent): boolean {
    const rawSymbol = event.tokenMetadata?.symbol?.trim()
    if (!rawSymbol) return false
    const normalized = normalizeSymbol(rawSymbol)
    if (normalized.length < 2) return false
    const now = Date.now()
    if (this.fuzzySymbolCache.size >= this.fuzzySymbolCacheMax) {
      for (const [k, v] of this.fuzzySymbolCache) {
        if (now - v.lastSeenAt > FUZZY_SYMBOL_WINDOW_MS) {
          this.fuzzySymbolCache.delete(k)
        }
      }
    }
    for (const [cachedNorm, entry] of this.fuzzySymbolCache) {
      if (now - entry.lastSeenAt > FUZZY_SYMBOL_WINDOW_MS) continue
      if (cachedNorm === normalized) {
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
      const similarity = stringSimilarity(cachedNorm, normalized)
      if (similarity >= FUZZY_SYMBOL_THRESHOLD) {
        log.debug(
          { normalized, cachedNorm, similarity: similarity.toFixed(2) },
          'Fuzzy symbol match detected',
        )
        entry.count++
        entry.lastSeenAt = now
        entry.symbols.add(rawSymbol)
        if (entry.count >= 3) return true
      }
    }
    this.fuzzySymbolCache.set(normalized, {
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      symbols: new Set([rawSymbol]),
    })
    return false
  }

  // NOVO: Deployer burst detection
  private isDeployerBurst(deployerAddress: string): boolean {
    const now = Date.now()
    if (this.deployerBurstCache.size >= this.deployerBurstCacheMax) {
      for (const [k, v] of this.deployerBurstCache) {
        if (now - v.lastSeenAt > DEPLOYER_BURST_WINDOW_MS) {
          this.deployerBurstCache.delete(k)
        }
      }
    }
    const existing = this.deployerBurstCache.get(deployerAddress)
    if (existing) {
      if (now - existing.firstSeenAt > DEPLOYER_BURST_WINDOW_MS) {
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

function isValidSolanaAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && SOLANA_ADDRESS_RE.test(addr)
}

export const pumpfunLaunchDetector = new PumpFunLaunchDetector()
```

---

## 4. `src/strategies/pumpfun-snipe.strategy.ts` (REESCRITO — substituir arquivo inteiro)

### O que mudou
- **Estratégia renomeada**: `pumpfun-snipe-v1` → `pumpfun-snipe-v2`
- **`decide()`** completamente reescrito com tiers:
  - Age gate (existente)
  - Position cap (existente)
  - Daily loss limit (existente)
  - **NOVO: Token age gate** — rejeita tokens com menos de `MIN_TOKEN_AGE_MS` (default 3s)
  - **NOVO: Fetch MC + tier decision** — determina tier baseado no market cap
  - **NOVO: Full token analysis** — chama `analyzeToken()` com fetch de metadata (cache Redis)
  - **NOVO: Tier-specific gates** — requisitos diferentes por tier
- **`checkTierGates()`** NOVO — método privado que aplica os gates específicos de cada tier
- **`determineTier()`** NOVO — função pura que classifica MC em tier
- **`analysisCache`** NOVO — cache em memória de TokenAnalysis por token address
- **Imports adicionados**: `analyzeToken`, `TokenAnalysis` de `../analysis/token-analyzer.js`

### Sistema de Tiers

```
Tier 1 (MC ≥ TIER1_MC_USD, default $8k):
  → score ≥ MIN_DETECTOR_SCORE (default 35)
  → Sem requisitos adicionais

Tier 2 (MC ≥ TIER2_MC_USD, default $5k):
  → score ≥ MIN_DETECTOR_SCORE_TIER2 (default 55)
  → Se REQUIRE_SOCIAL_TIER2=true: precisa ter Twitter ou Telegram

Tier 3 (MC ≥ MIN_ENTRY_MC_USD, default $2k):
  → score ≥ MIN_DETECTOR_SCORE_TIER3 (default 75)
  → Se REQUIRE_FRESH_DEPLOYER_TIER3=true: deployer não pode ser serial
  → Metadata precisa ter redes sociais OU descrição >10 caracteres

Abaixo de $2k:
  → REJEITADO automaticamente
```

### Fallback quando RPC falha
Se `fetchCurrentMcUsd()` retorna null (RPC offline), usa `detectorScore ≥ MIN_DETECTOR_SCORE_TIER3` como gate mínimo e assume Tier 1 (fail-open).

### Conteúdo completo do arquivo
```typescript
import { randomUUID } from 'node:crypto'
import { env } from '../config/env.js'
import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
import { paperExecutor } from '../executor/paper.executor.js'
import { realExecutor } from '../executor/real.executor.js'
import { solanaConnection } from '../utils/solana.utils.js'
import { fetchBondingCurveState } from '../executor/pumpfun-curve.js'
import {
  analyzeToken,
  type TokenAnalysis,
} from '../analysis/token-analyzer.js'
import {
  countOpenPositions,
  todayRealizedPnlSol,
} from '../positions/position.repository.js'
import {
  STREAMS,
  type ApprovedOpportunity,
  type TradeSignal,
  type PoolCreatedEvent,
} from '../events/event-types.js'
import type { BaseStrategy } from './base.strategy.js'
import type { BaseExecutor } from '../executor/base.executor.js'

const log = createChildLogger('pumpfun-snipe-strategy')

const SLIPPAGE_BPS = 1_500
const PRIORITY_FEE_LAMPORTS = 100_000
const SIGNAL_TTL_MS = 5_000
const MAX_SIGNAL_AGE_MS = 30_000
const CURVE_FETCH_TIMEOUT_MS = 2_000

type EntryTier = 'tier1' | 'tier2' | 'tier3' | 'rejected'

interface TierDecision {
  tier: EntryTier
  reason: string
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

export class PumpFunSnipeStrategy implements BaseStrategy {
  readonly name = 'pumpfun-snipe-v2'

  private running = false
  private readonly blockMs: number
  private readonly count: number
  private readonly consumerGroup: string
  private readonly executor: BaseExecutor

  private readonly analysisCache = new Map<string, TokenAnalysis>()
  private readonly analysisCacheMax = 1_000

  constructor(options: StrategyOptions = {}) {
    this.blockMs = options.blockMs ?? 2_000
    this.count = options.count ?? 5
    this.consumerGroup = options.consumerGroup ?? 'pumpfun-snipe-strategy'
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
        tradeSizeSol: env.TRADE_SIZE_SOL,
        maxOpen: env.MAX_OPEN_POSITIONS,
        dailyLossLimitSol: env.DAILY_LOSS_LIMIT_SOL,
        tiers: {
          tier1: `MC ≥ $${env.TIER1_MC_USD} → score ≥ ${env.MIN_DETECTOR_SCORE}`,
          tier2: `MC ≥ $${env.TIER2_MC_USD} → score ≥ ${env.MIN_DETECTOR_SCORE_TIER2}, socials: ${env.REQUIRE_SOCIAL_TIER2}`,
          tier3: `MC ≥ $${env.MIN_ENTRY_MC_USD} → score ≥ ${env.MIN_DETECTOR_SCORE_TIER3}, freshDeployer: ${env.REQUIRE_FRESH_DEPLOYER_TIER3}`,
        },
        minTokenAgeMs: env.MIN_TOKEN_AGE_MS,
      },
      'PumpFunSnipeStrategy v2 subscribed',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    this.analysisCache.clear()
    log.info('PumpFunSnipeStrategy stopped')
  }

  async decide(opp: ApprovedOpportunity): Promise<TradeSignal | null> {
    const ageMs = Date.now() - opp.timestamp
    if (ageMs > MAX_SIGNAL_AGE_MS) {
      log.debug({ tokenAddress: opp.tokenAddress, ageMs }, 'Opportunity stale — skip')
      return null
    }

    const open = await countOpenPositions(this.executor.mode)
    if (open >= env.MAX_OPEN_POSITIONS) {
      log.debug(
        { tokenAddress: opp.tokenAddress, open, cap: env.MAX_OPEN_POSITIONS },
        'Max open positions reached — skip',
      )
      return null
    }

    const todayPnl = await todayRealizedPnlSol(this.executor.mode)
    if (todayPnl <= -env.DAILY_LOSS_LIMIT_SOL) {
      log.warn(
        { todayPnl, limit: env.DAILY_LOSS_LIMIT_SOL, tokenAddress: opp.tokenAddress },
        'Daily loss limit hit — skip',
      )
      return null
    }

    const source = opp.sourceEvent as PoolCreatedEvent
    const tokenAgeMs = Date.now() - (source.timestamp ?? opp.timestamp)
    if (tokenAgeMs < env.MIN_TOKEN_AGE_MS) {
      log.debug(
        { tokenAddress: opp.tokenAddress, tokenAgeMs, min: env.MIN_TOKEN_AGE_MS },
        'Token too young — waiting for minimum age',
      )
      return null
    }

    let mcUsd: number | null = null
    if (env.MIN_ENTRY_MC_USD > 0) {
      mcUsd = await this.fetchCurrentMcUsd(opp.poolAddress)
      if (mcUsd === null) {
        log.debug({ tokenAddress: opp.tokenAddress }, 'MC fetch failed — using detector score gate only')
        if (opp.detectorScore < env.MIN_DETECTOR_SCORE_TIER3) {
          log.debug(
            { tokenAddress: opp.tokenAddress, score: opp.detectorScore, min: env.MIN_DETECTOR_SCORE_TIER3 },
            'Detector score below floor (MC unavailable) — skip',
          )
          return null
        }
      }
    }

    const effectiveMc = mcUsd ?? env.TIER1_MC_USD
    const { tier, reason: tierReason } = determineTier(effectiveMc)

    if (tier === 'rejected') {
      log.debug(
        { tokenAddress: opp.tokenAddress, mcUsd: effectiveMc, reason: tierReason },
        'MC below floor — rejected',
      )
      return null
    }

    let analysis = this.analysisCache.get(opp.tokenAddress)
    if (!analysis) {
      analysis = await analyzeToken(source)
      if (this.analysisCache.size >= this.analysisCacheMax) {
        const firstKey = this.analysisCache.keys().next().value
        if (firstKey !== undefined) this.analysisCache.delete(firstKey)
      }
      this.analysisCache.set(opp.tokenAddress, analysis)
    }

    const passReason = this.checkTierGates(tier, effectiveMc, analysis, opp)
    if (!passReason) return null

    const now = Date.now()
    const signal: TradeSignal = {
      signalId: randomUUID(),
      timestamp: now,
      protocol: opp.protocol,
      tokenAddress: opp.tokenAddress,
      poolAddress: opp.poolAddress,
      action: 'buy',
      amountSol: env.TRADE_SIZE_SOL,
      slippageBps: SLIPPAGE_BPS,
      priorityFeeLamports: PRIORITY_FEE_LAMPORTS,
      maxRetries: 1,
      expiresAt: now + SIGNAL_TTL_MS,
      strategy: this.name,
      opportunity: opp,
    }
    return signal
  }

  private checkTierGates(
    tier: EntryTier,
    mcUsd: number,
    analysis: TokenAnalysis,
    _opp: ApprovedOpportunity,
  ): string | null {
    const score = analysis.compositeScore
    const meta = analysis.metadata
    const deployer = analysis.deployerStats

    switch (tier) {
      case 'tier1': {
        if (score < env.MIN_DETECTOR_SCORE) {
          log.debug(
            {
              token: _opp.tokenAddress.slice(0, 10),
              tier: 'tier1',
              score,
              required: env.MIN_DETECTOR_SCORE,
              mcUsd: mcUsd.toFixed(0),
            },
            'Tier 1 score too low — reject',
          )
          return null
        }
        return `tier1: MC $${mcUsd.toFixed(0)}, score ${score}/${env.MIN_DETECTOR_SCORE}`
      }

      case 'tier2': {
        if (score < env.MIN_DETECTOR_SCORE_TIER2) {
          log.debug(
            {
              token: _opp.tokenAddress.slice(0, 10),
              tier: 'tier2',
              score,
              required: env.MIN_DETECTOR_SCORE_TIER2,
              mcUsd: mcUsd.toFixed(0),
            },
            'Tier 2 score too low — reject',
          )
          return null
        }
        if (env.REQUIRE_SOCIAL_TIER2) {
          if (meta && meta.socialCount === 0) {
            log.debug(
              {
                token: _opp.tokenAddress.slice(0, 10),
                tier: 'tier2',
                reason: 'no social links',
              },
              'Tier 2 requires social links — reject',
            )
            return null
          }
        }
        return `tier2: MC $${mcUsd.toFixed(0)}, score ${score}/${env.MIN_DETECTOR_SCORE_TIER2}`
      }

      case 'tier3': {
        if (score < env.MIN_DETECTOR_SCORE_TIER3) {
          log.debug(
            {
              token: _opp.tokenAddress.slice(0, 10),
              tier: 'tier3',
              score,
              required: env.MIN_DETECTOR_SCORE_TIER3,
              mcUsd: mcUsd.toFixed(0),
            },
            'Tier 3 score too low — reject',
          )
          return null
        }
        if (env.REQUIRE_FRESH_DEPLOYER_TIER3) {
          if (deployer.isSpamDeployer || deployer.tokenCount > 3) {
            log.debug(
              {
                token: _opp.tokenAddress.slice(0, 10),
                tier: 'tier3',
                deployerTokens: deployer.tokenCount,
                reason: 'deployer has history',
              },
              'Tier 3 requires fresh deployer — reject',
            )
            return null
          }
        }
        if (meta && meta.socialCount === 0 && meta.descriptionLength < 10) {
          log.debug(
            {
              token: _opp.tokenAddress.slice(0, 10),
              tier: 'tier3',
              reason: 'metadata too sparse',
            },
            'Tier 3 requires better metadata — reject',
          )
          return null
        }
        return `tier3: MC $${mcUsd.toFixed(0)}, score ${score}/${env.MIN_DETECTOR_SCORE_TIER3}`
      }

      default:
        return null
    }
  }

  private async fetchCurrentMcUsd(poolAddress: string): Promise<number | null> {
    try {
      const curve = await Promise.race([
        fetchBondingCurveState(solanaConnection, poolAddress),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CURVE_FETCH_TIMEOUT_MS)),
      ])
      if (!curve) return null
      const solUsdRaw = await eventBus.client.get('cache:sol_usd')
      const solUsd = solUsdRaw ? parseFloat(solUsdRaw) : 0
      if (solUsd <= 0) return null
      const mcSol = (curve.virtualSolReserves / curve.virtualTokenReserves) * 1_000_000_000
      return mcSol * solUsd
    } catch {
      return null
    }
  }

  private async handleApproved(
    opp: ApprovedOpportunity,
    messageId: string,
  ): Promise<void> {
    try {
      const signal = await this.decide(opp)
      if (!signal) return
      await eventBus.publish(STREAMS.SIGNALS, signal as unknown as Record<string, unknown>)
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

export const pumpfunSnipeStrategy = new PumpFunSnipeStrategy({
  executor: env.TRADING_MODE === 'real' ? realExecutor : paperExecutor,
})
```

---

## 5. `src/risk/checks/token-quality.check.ts` (NOVO — criar arquivo)

### O que é
Check rápido (0ms, zero I/O) que roda no Risk Engine e avalia qualidade de símbolo, nome e dev buy usando os dados já disponíveis no evento. Atribui score de risco para tokens com padrões suspeitos.

### Conteúdo completo do arquivo
```typescript
import type { CandidateOpportunity, PoolCreatedEvent } from '../../events/event-types.js'
import { analyzeSymbol, analyzeName, scoreDevBuy } from '../../analysis/token-analyzer.js'
import { fail, pass, type RiskCheck, type CheckResult } from './base.check.js'

export class TokenQualityCheck implements RiskCheck {
  readonly name = 'token-quality'
  readonly weight = 0.10

  async evaluate(candidate: CandidateOpportunity): Promise<CheckResult> {
    const source = candidate.sourceEvent as PoolCreatedEvent
    const md = source.tokenMetadata
    const devBuySol = source.initialBuySol ?? 0

    const sym = analyzeSymbol(md?.symbol)
    if (sym.score <= 10) {
      return fail(
        'high',
        75,
        `symbol quality critical: score=${sym.score} flags=[${sym.flags.join(',')}]`,
      )
    }
    if (sym.score <= 30) {
      return fail(
        'medium',
        45,
        `symbol quality poor: score=${sym.score} flags=[${sym.flags.join(',')}]`,
      )
    }

    const name = analyzeName(md?.name)
    if (name.score <= 10) {
      return fail(
        'high',
        70,
        `name quality critical: score=${name.score} flags=[${name.flags.join(',')}]`,
      )
    }
    if (name.score <= 25) {
      return fail(
        'medium',
        40,
        `name quality poor: score=${name.score} flags=[${name.flags.join(',')}]`,
      )
    }

    const devBuyScore = scoreDevBuy(devBuySol)
    if (devBuyScore <= 5) {
      return fail(
        'high',
        65,
        `zero dev buy commitment: ${devBuySol.toFixed(4)} SOL`,
      )
    }
    if (devBuyScore <= 15) {
      return fail(
        'medium',
        35,
        `low dev buy: ${devBuySol.toFixed(4)} SOL`,
      )
    }

    const hasUri = Boolean(md?.uri && md.uri.length > 0)
    const hasName = Boolean(md?.name && md.name.length >= 3)
    const hasSymbol = Boolean(md?.symbol && md.symbol.length >= 2)

    const missingFields: string[] = []
    if (!hasUri) missingFields.push('uri')
    if (!hasName) missingFields.push('name')
    if (!hasSymbol) missingFields.push('symbol')

    if (missingFields.length >= 2) {
      return fail(
        'medium',
        30,
        `missing metadata fields: [${missingFields.join(',')}]`,
      )
    }
    if (missingFields.length === 1) {
      return pass(`metadata OK (missing: ${missingFields[0]})`)
    }

    return pass(
      `symbol=${sym.score} name=${name.score} devBuy=${devBuyScore} metadata=complete`,
    )
  }
}

export const tokenQualityCheck = new TokenQualityCheck()
```

---

## 6. `src/risk/risk-engine.ts` (MODIFICADO)

### Alterações

**1. Adicionar import do novo check:**
```typescript
import { tokenQualityCheck } from './checks/token-quality.check.js'
```
Adicionar logo abaixo de:
```typescript
import { mintFreezeAuthorityCheck } from './checks/mint-freeze-authority.check.js'
```

**2. Adicionar `tokenQualityCheck` ao array `checks` (primeira posição):**
```typescript
  private readonly checks: RiskCheck[] = [
    tokenQualityCheck,   // <-- NOVO: adicionar aqui
    liquidityCheck,
    deployerBlacklistCheck,
    mintFreezeAuthorityCheck,
  ]
```

**3. Atualizar comentário da pipeline (opcional):**
```
// Sequential fail-fast pipeline:
//   1. token-quality  — payload only, 0ms (NEW: symbol/name/devBuy heuristic)
//   2. liquidity      — payload only, 0ms
//   3. blacklist      — Redis hash lookup, <1ms cached
//   4. mint+freeze    — 1 RPC call, ~150ms cached
```

---

## Pipeline Final (Depois)

```
PumpPortal WS Listener
    ↓ (events:raw)
Parser (pumpfun.parser.ts)
    ↓ (events:parsed)
Detector (pumpfun-launch.detector.ts)           ← scoring multi-dimensional
    • Fuzzy symbol spam detection               ← NOVO
    • Deployer burst detection                  ← NOVO
    • Score mínimo gate (score < 15 = reject)   ← NOVO
    ↓ (events:candidates)
Risk Engine (risk-engine.ts)
    • token-quality (symbol/name/devBuy)        ← NOVO
    • liquidity
    • deployer-blacklist
    • mint-freeze-authority
    ↓ (events:approved)
Strategy (pumpfun-snipe.strategy.ts)            ← sistema de tiers
    • Token age gate (MIN_TOKEN_AGE_MS)         ← NOVO
    • MC fetch + tier determination              ← NOVO
    • Full token analysis (metadata fetch)       ← NOVO
    • Tier-specific gates (score, socials, deployer) ← NOVO
    ↓ (events:signals)
Executor (paper ou real)
```

---

## Como Ajustar os Thresholds

Os thresholds podem ser ajustados via `.env`. Recomendações:

| Parâmetro | Conservador | Balanceado | Agressivo |
|-----------|-------------|------------|-----------|
| `MIN_ENTRY_MC_USD` | 4000 | 2000 | 1000 |
| `TIER1_MC_USD` | 10000 | 8000 | 6000 |
| `TIER2_MC_USD` | 7000 | 5000 | 3500 |
| `MIN_DETECTOR_SCORE` | 50 | 35 | 25 |
| `MIN_DETECTOR_SCORE_TIER2` | 65 | 55 | 45 |
| `MIN_DETECTOR_SCORE_TIER3` | 85 | 75 | 60 |
| `REQUIRE_SOCIAL_TIER2` | true | true | false |
| `REQUIRE_FRESH_DEPLOYER_TIER3` | true | true | false |
| `MIN_TOKEN_AGE_MS` | 5000 | 3000 | 1000 |

### Lógica dos thresholds
- **Mais conservador**: Aumenta thresholds de score, exige mais qualidade. Menos entradas, menos rug pulls.
- **Mais agressivo**: Reduz thresholds, aceita tokens mais arriscados. Mais entradas, mais rug pulls.
- **`REQUIRE_SOCIAL_TIER2=true`**: Tier 2 exige Twitter ou Telegram. Desligar aceita tokens sem redes sociais.
- **`REQUIRE_FRESH_DEPLOYER_TIER3=true`**: Tier 3 exige deployer com ≤3 tokens. Desligar aceita deployers com histórico.
- **`MIN_TOKEN_AGE_MS`**: Tempo mínimo de existência do token. 3000ms = 3 segundos. Rug pulls atômicos acontecem em <2s.

---

## Verificação

Após aplicar as alterações:

```bash
cd /Users/arthurzimmer/Downloads/solana-memecoin-bot-main
npm run typecheck       # Verificar tipos TypeScript
npm run dev             # Rodar em modo paper para testar
```

Observar nos logs as novas mensagens:
- `Symbol quality analysis` — análise de símbolo
- `Name quality analysis` — análise de nome
- `Launch multi-dimension score` — score composto do detector
- `FUZZY SYMBOL SPAM` — spam detectado por similaridade
- `DEPLOYER BURST` — serial deployer detectado
- `Tier 1/Tier 2/Tier 3 score too low` — rejeição por score insuficiente
- `Tier X requires social links` — rejeição por falta de redes sociais
- `Tier 3 requires fresh deployer` — rejeição por histórico do deployer
