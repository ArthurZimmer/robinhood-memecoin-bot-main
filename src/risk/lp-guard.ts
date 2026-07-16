import { Contract } from 'ethers'
import { env } from '../config/env.js'
import { rhProvider } from '../utils/robbinhood.utils.js'
import { createChildLogger } from '../utils/logger.js'

const log = createChildLogger('lp-guard')

const PAIR_ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]

export interface LpGuardResult {
  ok: boolean
  deployerLpPct: number | null
  detail: string
}

/**
 * LP-pull guard — a pair's LP tokens are themselves ERC-20; whoever holds them
 * can drain the pool in a single tx. Calibrated on live pairs (2026-07-16):
 * legit launches on this chain BURN 100% of the LP at creation (deployer
 * balance 0%), while the serial rug factory keeps ~100% and pulls ~19.5min
 * after launch. Rejects when the deployer holds more than
 * LP_MAX_DEPLOYER_PCT of the LP supply.
 *
 * Fail-closed: an entry we cannot verify is an entry we do not take.
 */
export async function checkLpConcentration(
  poolAddress: string,
  deployerAddress: string,
): Promise<LpGuardResult> {
  try {
    const pair = new Contract(poolAddress, PAIR_ERC20_ABI, rhProvider)
    const [deployerBal, totalSupply] = (await Promise.all([
      pair.balanceOf!(deployerAddress),
      pair.totalSupply!(),
    ])) as [bigint, bigint]

    if (totalSupply <= 0n) {
      return { ok: false, deployerLpPct: null, detail: 'LP totalSupply is zero' }
    }

    const pct = Number((deployerBal * 10_000n) / totalSupply) / 100
    if (pct > env.LP_MAX_DEPLOYER_PCT) {
      return {
        ok: false,
        deployerLpPct: pct,
        detail: `deployer holds ${pct.toFixed(2)}% of LP (max ${env.LP_MAX_DEPLOYER_PCT}%) — LP-pull risk`,
      }
    }

    return { ok: true, deployerLpPct: pct, detail: `deployer LP ${pct.toFixed(2)}%` }
  } catch (err) {
    log.warn({ err, poolAddress }, 'LP concentration read failed — fail-closed')
    return {
      ok: false,
      deployerLpPct: null,
      detail: `LP check failed (fail-closed): ${(err as Error).message.slice(0, 80)}`,
    }
  }
}
