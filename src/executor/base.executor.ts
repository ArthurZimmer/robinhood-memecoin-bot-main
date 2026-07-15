import type { TradeSignal } from '../events/event-types.js'

export interface ExecutionResult {
  /** Did the trade execute successfully? */
  success: boolean
  /** Position ID created/updated in DB (null if execution failed before persistence). */
  positionId: string | null
  /** Tokens received (for buy) or ETH received (for sell), as decimal string. */
  outputAmount: string
  /** Effective execution price (ETH per token). */
  executionPrice: number
  /** Slippage actually realized vs expected (%). */
  realizedSlippagePct: number
  /** Tx signature (real mode) or `paper:<uuid>` synthetic (paper mode). */
  txSignature: string
  /** Wall-clock execution duration (ms). */
  durationMs: number
  /** Human-readable error if !success. */
  error?: string
}

export interface BaseExecutor {
  readonly mode: 'paper' | 'real'
  execute(signal: TradeSignal): Promise<ExecutionResult>
}
