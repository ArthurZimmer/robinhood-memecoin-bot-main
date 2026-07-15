import { id } from 'ethers'
import { createChildLogger } from '../utils/logger.js'
import { rhProvider } from '../utils/robbinhood.utils.js'
import { eventBus } from '../events/event-bus.js'

const log = createChildLogger('capability-scan')

// ── Contract capability scan ──────────────────────────────────────────────────
// Static bytecode heuristic for DYNAMIC honeypots — tokens that are sellable at
// entry but whose owner can later block or tax exits (blacklist, trading pause,
// max-tx shrink to zero, sell-fee hike). The honeypot probe cannot see these:
// it only proves the token is sellable NOW.
//
// Rule: a token is rejected when its bytecode exposes a sell-blocking setter
// AND ownership has not been renounced (someone can still call it).
//
// Function selectors appear as PUSH4 constants in the Solidity dispatcher, so a
// hex substring scan on getCode() output is sufficient for non-proxy contracts.
// Proxies and obfuscated dispatchers can evade this — it narrows the risk, it
// does not eliminate it.

const SELL_BLOCKING_SIGNATURES = [
  // Blacklists / bot lists
  'blacklist(address)',
  'blacklist(address,bool)',
  'setBlacklist(address,bool)',
  'addBlacklist(address)',
  'addToBlacklist(address)',
  'setBlacklisted(address,bool)',
  'setBots(address[])',
  'addBots(address[])',
  'blockAccount(address)',
  // Trading switches
  'pause()',
  'setTrading(bool)',
  'disableTrading()',
  'setTradingEnabled(bool)',
  'setSwapEnabled(bool)',
  // Limits that can be shrunk until sells are impossible
  'setMaxTxAmount(uint256)',
  'setMaxTx(uint256)',
  'setMaxWalletAmount(uint256)',
  'setMaxWallet(uint256)',
  // Fee hikes
  'setSellFee(uint256)',
  'setSellTax(uint256)',
  'setFees(uint256,uint256)',
  'setTaxes(uint256,uint256)',
  'setFee(uint256)',
]

const SELECTORS: Array<{ sig: string; selector: string }> =
  SELL_BLOCKING_SIGNATURES.map((sig) => ({
    sig,
    selector: id(sig).slice(2, 10),
  }))

const OWNER_CALLDATA = '0x8da5cb5b' // owner()
const RENOUNCED_OWNERS = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
])

const CACHE_PREFIX = 'capscan:'
const CACHE_TTL_S = 86_400 // bytecode is immutable — cache verdicts for a day

export interface CapabilityScanResult {
  /** true = safe to buy (no reachable sell-blocking capability found). */
  ok: boolean
  /** Matched dangerous function signatures ([] = clean bytecode). */
  dangerous: string[]
  /** true when owner() is the zero/dead address. Unknown owner counts as NOT renounced. */
  ownerRenounced: boolean
  /** Set on network failure — caller fails closed. Not cached. */
  error?: 'rpc-error'
}

/**
 * Scan a token's deployed bytecode for sell-blocking capabilities reachable by
 * a live owner. Verdicts are cached in Redis (bytecode never changes).
 */
export async function scanTokenCapabilities(
  tokenAddress: string,
): Promise<CapabilityScanResult> {
  const cacheKey = `${CACHE_PREFIX}${tokenAddress.toLowerCase()}`

  try {
    const cached = await eventBus.client.get(cacheKey)
    if (cached) return JSON.parse(cached) as CapabilityScanResult
  } catch {
    // Redis hiccup — proceed to live scan
  }

  let result: CapabilityScanResult
  try {
    const code = (await rhProvider.getCode(tokenAddress)).toLowerCase()
    const dangerous = SELECTORS.filter(({ selector }) =>
      code.includes(selector),
    ).map(({ sig }) => sig)

    let ownerRenounced = false
    if (dangerous.length > 0) {
      // Only fetch owner when it matters — saves an eth_call on clean tokens.
      try {
        const raw = await rhProvider.call({ to: tokenAddress, data: OWNER_CALLDATA })
        if (raw && raw.length >= 42) {
          const owner = ('0x' + raw.slice(-40)).toLowerCase()
          ownerRenounced = RENOUNCED_OWNERS.has(owner)
        }
      } catch {
        // owner() reverted or absent — cannot prove renouncement, fail closed
        ownerRenounced = false
      }
    }

    result = { ok: dangerous.length === 0 || ownerRenounced, dangerous, ownerRenounced }
  } catch (err) {
    log.warn(
      { tokenAddress, err: (err as Error).message?.slice(0, 120) },
      'Capability scan RPC error — failing closed',
    )
    // Transient failure: not cached, so the next candidate retry re-scans.
    return { ok: false, dangerous: [], ownerRenounced: false, error: 'rpc-error' }
  }

  try {
    await eventBus.client.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_S)
  } catch {
    // non-fatal
  }

  return result
}
