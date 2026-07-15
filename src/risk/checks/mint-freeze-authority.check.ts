import { Contract } from 'ethers'
import { rhProvider } from '../../utils/robbinhood.utils.js'
import { createChildLogger } from '../../utils/logger.js'
import { eventBus } from '../../events/event-bus.js'
import type { CandidateOpportunity } from '../../events/event-types.js'
import { fail, pass, skipped, type RiskCheck, type CheckResult } from './base.check.js'

const log = createChildLogger('check:mint-freeze-auth')

// ── Owner Renouncement check (EVM) ──────────────────────────────────────────
// On EVM, there is no "mint authority" or "freeze authority" concept like Solana
// SPL tokens. Instead, we check if the ERC-20 token contract's owner() is the
// zero address — meaning ownership has been renounced and no one can mint new
// tokens or modify the contract.
//
// Unlike Pump.fun (which atomically renounces ownership at creation), Uniswap V2
// tokens are regular ERC-20s — ownership must be verified on-chain for every token.
// No protocol-level trust bypass applies.
//
// ERC-20 ABI: owner() returns address. address(0) = renounced.

const TOKEN_OWNER_ABI = [
  'function owner() view returns (address)',
]

const CACHE_KEY_PREFIX = 'risk:evm-owner:'
const CACHE_TTL_SECONDS = 60
const RPC_TIMEOUT_MS = 2_500

export class MintFreezeAuthorityCheck implements RiskCheck {
  readonly name = 'mint-freeze-authority'
  readonly weight = 0.35

  async evaluate(candidate: CandidateOpportunity): Promise<CheckResult> {
    const tokenAddress = candidate.tokenAddress
    let owner: string | null = null
    try {
      owner = await this.getOwner(tokenAddress)
    } catch (err) {
      log.debug(
        { err, tokenAddress, protocol: candidate.protocol },
        'Owner fetch failed — using fallback',
      )
      return this.fallbackForProtocol(candidate, 'rpc unavailable')
    }

    if (owner === null) {
      return this.fallbackForProtocol(candidate, 'token contract not found yet')
    }

    // address(0) = ownership renounced — safe
    const isRenounced = owner === '0x0000000000000000000000000000000000000000'

    if (!isRenounced) {
      // Severity 'high' instead of 'critical': on Uniswap V2 (Robinhood Chain),
      // most memecoin deployers do NOT renounce ownership at launch. A critical
      // here would reject every token unconditionally. Still penalize heavily
      // (100 pts × 0.35 weight = 35 risk points) but let other checks decide.
      return fail(
        'high',
        100,
        `token ownership NOT renounced — owner=${owner}`,
      )
    }

    return pass('token ownership renounced (owner = address(0))')
  }

  /**
   * RPC failure fallback. For Uniswap V2 tokens, there is no protocol-level
   * trust — every token is a regular ERC-20. If RPC is unavailable, the check
   * is skipped (pass-through but flagged for audit).
   */
  private fallbackForProtocol(
    _candidate: CandidateOpportunity,
    reason: string,
  ): CheckResult {
    return skipped(reason)
  }

  private async getOwner(tokenAddress: string): Promise<string | null> {
    // Redis cache lookup
    const cached = await eventBus.client.get(`${CACHE_KEY_PREFIX}${tokenAddress}`)
    if (cached) {
      return cached === '__null__' ? null : cached
    }

    try {
      const contract = new Contract(tokenAddress, TOKEN_OWNER_ABI, rhProvider)
      const owner = await withTimeout(
        contract.owner!() as Promise<string>,
        RPC_TIMEOUT_MS,
      )

      await eventBus.client.set(
        `${CACHE_KEY_PREFIX}${tokenAddress}`,
        owner,
        'EX',
        CACHE_TTL_SECONDS,
      )
      return owner
    } catch (err) {
      // Cache the failure briefly to avoid repeated RPC timeouts
      await eventBus.client.set(
        `${CACHE_KEY_PREFIX}${tokenAddress}`,
        '__null__',
        'EX',
        CACHE_TTL_SECONDS,
      )
      throw err
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const mintFreezeAuthorityCheck = new MintFreezeAuthorityCheck()
