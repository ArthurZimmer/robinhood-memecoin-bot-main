import type { CandidateOpportunity, PoolCreatedEvent } from '../../events/event-types.js'
import { analyzeSymbol, analyzeName, scoreInitialLiquidity } from '../../analysis/token-analyzer.js'
import { WETH_ADDRESS } from '../../utils/robbinhood.utils.js'
import { fail, pass, type RiskCheck, type CheckResult } from './base.check.js'

// ── Token quality check ─────────────────────────────────────────────────────
// Fast, zero-IO quality analysis based on the parsed event data.
// Catches obvious scam patterns (keyboard smash names, near-zero liquidity, etc.)
// BEFORE the token reaches the strategy layer.
//
// This check runs BEFORE metadata fetch (which is expensive and happens in
// the strategy). It uses only the data already available in the event payload.
// Weight is moderate — won't single-handedly reject a token but contributes
// to the risk score so high-MC tokens with suspicious patterns still pass.

export class TokenQualityCheck implements RiskCheck {
  readonly name = 'token-quality'
  readonly weight = 0.10 // 10% — supplemental, not primary

  async evaluate(candidate: CandidateOpportunity): Promise<CheckResult> {
    const source = candidate.sourceEvent as PoolCreatedEvent
    const md = source.tokenMetadata

    // Compute initial ETH liquidity from pair reserves (replaces Pump.fun dev-buy)
    const initialLiquidityNative = this.computeInitialLiquidity(source)

    // ── Symbol analysis ─────────────────────────────────────────────────────
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

    // ── Name analysis ───────────────────────────────────────────────────────
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

    // ── Initial liquidity commitment ────────────────────────────────────────
    // For Uniswap V2, the deployer provides initial liquidity to the pair.
    // Near-zero liquidity = likely rug or honeypot.
    const liquidityScore = scoreInitialLiquidity(initialLiquidityNative)
    if (liquidityScore <= 5) {
      return fail(
        'high',
        65,
        `near-zero initial liquidity: ${initialLiquidityNative.toFixed(4)} ETH`,
      )
    }
    if (liquidityScore <= 15) {
      return fail(
        'medium',
        35,
        `low initial liquidity: ${initialLiquidityNative.toFixed(4)} ETH`,
      )
    }

    // ── Metadata presence ───────────────────────────────────────────────────
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
      // Single missing field — just a flag, not a failure
      return pass(`metadata OK (missing: ${missingFields[0]})`)
    }

    return pass(
      `symbol=${sym.score} name=${name.score} liquidity=${liquidityScore} metadata=complete`,
    )
  }

  /** Determine initial ETH liquidity from the pair creation event reserves. */
  private computeInitialLiquidity(event: PoolCreatedEvent): number {
    const r0 = event.reserve0
    const r1 = event.reserve1
    if (!r0 || !r1) return 0

    const wethLower = WETH_ADDRESS.toLowerCase()
    const t0 = event.token0?.toLowerCase()
    const t1 = event.token1?.toLowerCase()

    try {
      if (t0 === wethLower) return parseFloat(r0) / 1e18
      if (t1 === wethLower) return parseFloat(r1) / 1e18
    } catch {
      // parseFloat failure on malformed reserve string
    }
    return 0
  }
}

export const tokenQualityCheck = new TokenQualityCheck()
