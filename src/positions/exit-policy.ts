// ── Exit policy ──────────────────────────────────────────────────────────────
// Pure decision function for position exits — no imports, no I/O, fully unit-
// testable. PositionManager.decide() is a thin wrapper that feeds it live state.
//
// Strategy: de-risk + trailing stop (moonshot capture).
//   1. Hard stop-loss — unchanged, full exit of whatever remains.
//   2. Trailing stop — arms once the PEAK reaches trailingArmPct over entry;
//      after that, a drawdown of trailingStopPct from the peak sells 100% of
//      the remainder. The peak is monotonic, so the fire level only ratchets
//      up. With arm=100 / trail=30 the minimum fire level is
//      entry × 2 × 0.7 = entry × 1.4 — an armed position can no longer
//      round-trip into a loss (barring a gap through the level).
//   3. De-risk at TP — fires ONCE (status gate): sells sellPctAtTp% at
//      +tpPct to recover the entry cost, flipping the position into a
//      moonbag (partial_exit) that the trailing stop manages. sellPctAtTp=100
//      reproduces the legacy full-exit-at-TP behaviour exactly.

export type ExitReason = 'stop-loss' | 'take-profit' | 'trailing-stop'

export interface ExitPolicyInput {
  entryPrice: number
  spotPrice: number
  /** Highest post-entry spot price observed (caller keeps it monotonic). */
  peakPrice: number
  /** Position['status'] — only 'open' and 'partial_exit' are actionable. */
  status: string
  slPct: number
  tpPct: number
  /** % of the position to sell when TP hits. 100 (or ≤0) = legacy full exit. */
  sellPctAtTp: number
  /** Drawdown-from-peak % that triggers a full exit. 0 disables trailing. */
  trailingStopPct: number
  /** Peak pnl% over entry required before the trailing stop arms. */
  trailingArmPct: number
}

export interface ExitDecision {
  sellPct: number
  reason: ExitReason
  pnlPct: number
}

export function decideExit(input: ExitPolicyInput): ExitDecision | null {
  const { entryPrice, spotPrice, status } = input

  if (status !== 'open' && status !== 'partial_exit') return null
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null

  const pnlPct = ((spotPrice - entryPrice) / entryPrice) * 100

  // 1. Hard stop-loss — full exit of the remainder (applies to moonbags too)
  if (pnlPct <= -input.slPct) {
    return { sellPct: 100, reason: 'stop-loss', pnlPct }
  }

  // 2. Trailing stop — full exit dominates the partial de-risk below, so a
  //    tick where both trigger (e.g. first tick after a restart) sells in one
  //    transaction instead of two.
  if (input.trailingStopPct > 0) {
    const peak = Math.max(input.peakPrice, spotPrice, entryPrice)
    const peakPnlPct = ((peak - entryPrice) / entryPrice) * 100
    if (
      peakPnlPct >= input.trailingArmPct
      && spotPrice <= peak * (1 - input.trailingStopPct / 100)
    ) {
      return { sellPct: 100, reason: 'trailing-stop', pnlPct }
    }
  }

  // 3. De-risk at TP — the status gate makes this fire exactly once: the
  //    partial sell flips status to 'partial_exit'.
  if (status === 'open' && pnlPct >= input.tpPct) {
    const sellPct = input.sellPctAtTp >= 100 || input.sellPctAtTp <= 0
      ? 100
      : input.sellPctAtTp
    return { sellPct, reason: 'take-profit', pnlPct }
  }

  return null
}
