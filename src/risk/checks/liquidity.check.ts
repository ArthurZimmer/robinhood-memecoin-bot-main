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

    // HARD REJECT. This was 'high' to tolerate a PairCreated→addLiquidity race,
    // but an LP-pull rug factory exploits exactly that leniency: create the pair
    // EMPTY (passes evaluation on aggregate score), inject liquidity afterwards,
    // pump, and pull ~90-120s after entry — observed 2026-07-15 as two total
    // losses with this fingerprint (flags token-quality+liquidity, score 22).
    // Legit launches on this chain add liquidity atomically with pair creation,
    // so a zero here is the scam signature, not a race.
    if (!Number.isFinite(lp) || lp <= 0) {
      return fail('critical', 80, `zero liquidity at evaluation — LP-pull factory fingerprint: ${lp}`)
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
