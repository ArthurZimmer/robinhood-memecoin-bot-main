import { env } from '../../config/env.js'
import type { CandidateOpportunity } from '../../events/event-types.js'
import { fail, pass, type RiskCheck, type CheckResult } from './base.check.js'

// ── Liquidity check ──────────────────────────────────────────────────────────
// Uniswap V2 pairs are created with real initial liquidity in the pair contract.
// Typically 0.05-0.5 ETH for memecoins. Reject if effective liquidity below
// MIN_LIQUIDITY_NATIVE — usually means payload missing fields or a malformed launch.

const MIN_LIQUIDITY_NATIVE = 0.025 // floor — anything below = malformed or sketchy

export class LiquidityCheck implements RiskCheck {
  readonly name = 'liquidity'
  readonly weight = 0.15

  async evaluate(candidate: CandidateOpportunity): Promise<CheckResult> {
    const lp = candidate.initialLiquidityNative

    // Severity 'high' instead of 'critical': on Uniswap V2, the PairCreated event
    // can fire before initial liquidity is added to the pair (race condition).
    // A 'critical' here would permanently reject tokens with transient zero reserves.
    // The strategy re-fetches reserves before trading, so a 0 here is not terminal.
    if (!Number.isFinite(lp) || lp <= 0) {
      return fail('high', 80, `liquidity not yet available: ${lp}`)
    }

    if (lp < MIN_LIQUIDITY_NATIVE) {
      return fail(
        'high',
        70,
        `liquidity ${lp.toFixed(6)} ETH < floor ${MIN_LIQUIDITY_NATIVE}`,
      )
    }

    // Bonus check: trade size sanity. If trade > 5% of LP, slippage will crush us.
    const trade = env.TRADE_SIZE_NATIVE
    const impactPct = (trade / lp) * 100
    if (impactPct > 5) {
      return fail(
        'medium',
        40,
        `trade size ${trade} ETH = ${impactPct.toFixed(2)}% of LP — slippage too high`,
      )
    }

    return pass(`LP ${lp.toFixed(6)} ETH — trade impact ${impactPct.toFixed(2)}%`)
  }
}

export const liquidityCheck = new LiquidityCheck()
