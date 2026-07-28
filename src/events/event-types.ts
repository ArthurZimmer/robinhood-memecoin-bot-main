// ─────────────────────────────────────────────────────────────────────────────
// Internal event types flowing through Redis Streams
// Each stage of the pipeline consumes one stream and produces another
// ─────────────────────────────────────────────────────────────────────────────

// ── Stream names ──────────────────────────────────────────────────────────────
export const STREAMS = {
  RAW: 'events:raw',
  PARSED: 'events:parsed',
  CANDIDATES: 'events:candidates',
  APPROVED: 'events:approved',
  SIGNALS: 'events:signals',
  POSITIONS: 'events:positions',
  NOTIFICATIONS: 'events:notifications',
} as const

export type StreamName = (typeof STREAMS)[keyof typeof STREAMS]

// ── Protocols ─────────────────────────────────────────────────────────────────
// Robinhood Chain DEXes and launch platforms
export type Protocol = 'pumpfun' | 'robbinhood' | 'uniswap'

// ── Base ──────────────────────────────────────────────────────────────────────
export interface BaseEvent {
  eventId: string
  timestamp: number // Unix ms
  protocol: Protocol
  blockNumber?: number
  blockTime?: number
}

// ── Raw event (Listener → Parser) ────────────────────────────────────────────
export interface RawEvent extends BaseEvent {
  type: 'raw'
  source: 'websocket' | 'rpc_poll' | 'mempool'
  rawData: Record<string, unknown> // Raw log / tx receipt / mempool tx
}

// ── Parsed events (Parser → Detector) ────────────────────────────────────────
export interface TokenLaunchEvent extends BaseEvent {
  type: 'token_launch'
  tokenAddress: string       // ERC-20 token address (0x-prefixed hex)
  deployerAddress: string
  decimals: number
  totalSupply: string
  metadata?: {
    name?: string
    symbol?: string
    uri?: string
  }
}

export interface PoolCreatedEvent extends BaseEvent {
  type: 'pool_created'
  poolAddress: string         // Uniswap V2 pair contract address
  tokenAddress: string        // ERC-20 token address (the memecoin)
  quoteTokenAddress: string   // WETH address (or NATIVE_ETH sentinel)
  deployerAddress: string     // address that called addLiquidity / created the pair
  txHash?: string             // originating tx hash — useful for analytics/debug
  tokenMetadata?: {
    name?: string
    symbol?: string
    uri?: string
  }
  // Uniswap V2 pair state snapshot — used by paper executor pricing and initial LP tracking
  /** Pair's token0 address (may be WETH or the memecoin — check ordering). */
  token0?: string
  /** Pair's token1 address. */
  token1?: string
  /** Initial reserve0 (raw wei string — use token decimals to convert). */
  reserve0?: string
  /** Initial reserve1 (raw wei string). */
  reserve1?: string
  /** Token total supply (raw wei string). */
  totalSupply?: string
  /** Token decimals (fetched from ERC-20 contract). */
  tokenDecimals?: number
  /** All-pairs count from the factory at creation time. */
  allPairsLength?: number
}

export interface SwapEvent extends BaseEvent {
  type: 'swap'
  poolAddress: string
  tokenAddress: string
  side: 'buy' | 'sell'
  amountIn: string
  amountOut: string
  walletAddress: string
  txHash?: string
}

export type ParsedEvent = TokenLaunchEvent | PoolCreatedEvent | SwapEvent

// ── Candidate opportunity (Detector → Risk Engine) ───────────────────────────
export interface CandidateOpportunity {
  candidateId: string
  timestamp: number
  protocol: Protocol
  tokenAddress: string
  poolAddress: string
  deployerAddress: string
  initialLiquidityNative: number
  estimatedMarketCapNative?: number
  detectorScore: number // 0-100 — how interesting the detector thinks this is
  sourceEvent: ParsedEvent
}

// ── Risk result (Risk Engine → Strategy) ─────────────────────────────────────
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface RiskResult {
  passed: boolean
  riskScore: number // 0-100 (higher = riskier)
  riskLevel: RiskLevel
  flags: string[] // human-readable list of triggered checks
  checks: Record<
    string,
    {
      passed: boolean
      score: number
      detail?: string
    }
  >
  evaluatedAt: number
}

export interface ApprovedOpportunity extends CandidateOpportunity {
  risk: RiskResult
}

// ── Honeypot probe result (Strategy → Executor) ──────────────────────────────
// Result of simulating a full buy->sell round trip via eth_call state override.
// Carried on the signal so the paper executor can apply realistic fee-on-transfer
// taxes, and the real executor can persist it for audit.
export interface HoneypotProbeResult {
  buyTaxPct: number
  sellTaxPct: number
  roundTripPct: number
}

// ── Trade signal (Strategy → Executor) ───────────────────────────────────────
export interface TradeSignal {
  signalId: string
  timestamp: number
  protocol: Protocol
  tokenAddress: string
  poolAddress: string
  action: 'buy' | 'sell'
  amountNative: number
  slippageBps: number
  // EIP-1559 gas parameters (optional — executor uses defaults if unset)
  gasLimit?: number
  maxFeePerGas?: number
  maxPriorityFeePerGas?: number
  maxRetries: number
  expiresAt: number // Unix ms — signal stale after this
  strategy: string // which strategy generated this
  opportunity: ApprovedOpportunity
  /** Honeypot/tax probe result (present when the strategy ran a probe before buying). */
  honeypotProbe?: HoneypotProbeResult
  /**
   * Deployer's share of the pair's LP supply at entry, percent. Persisted so a
   * post-mortem can tell whether the LP-pull guard was fooled or simply not the
   * mechanism used — without it, a drained pool is indistinguishable from a
   * token-level rug after the fact.
   */
  deployerLpPct?: number
}

// ── Position events (Position Manager → Notifications) ───────────────────────
export type PositionEventType =
  | 'position_opened'
  | 'take_profit_triggered'
  | 'take_profit_executed'
  | 'stop_loss_triggered'
  | 'moonbag_activated'
  | 'position_closed'
  | 'position_updated'

export interface PositionEvent {
  positionEventId: string
  type: PositionEventType
  positionId: string
  tokenAddress: string
  timestamp: number
  data: Record<string, unknown>
}

// ── Notification event (Notifications ← Position Manager / other) ─────────────
export interface NotificationEvent {
  notificationId: string
  timestamp: number
  type: 'alert' | 'action_required' | 'info'
  title: string
  body: string
  positionId?: string
  actions?: Array<{
    label: string
    callbackData: string
  }>
}
