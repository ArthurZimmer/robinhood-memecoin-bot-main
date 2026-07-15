import { Interface } from 'ethers'
import { createChildLogger } from '../utils/logger.js'
import { env } from '../config/env.js'
import { rhProvider, UNISWAP_ROUTER_ADDRESS, WETH_ADDRESS } from '../utils/robbinhood.utils.js'
import { eventBus } from '../events/event-bus.js'

const log = createChildLogger('honeypot-probe')

// ── Honeypot probe ─────────────────────────────────────────────────────────────
// Simulates a full buy -> approve -> sell round trip against the Uniswap V2
// router in a SINGLE eth_call, using state override to inject the HoneypotProbe
// contract code + ETH balance onto a synthetic address. Nothing is broadcast —
// zero gas, zero on-chain footprint.
//
// Catches the #1 EVM sniping loss vector that the AMM math (and therefore paper
// mode) cannot see: tokens you can buy but can't sell (blacklist, paused
// trading, 100% sell tax), plus fee-on-transfer taxes measured as the delta
// between router quotes and actual balance changes.
//
// Source of the injected bytecode: contracts/HoneypotProbe.sol
// Recompile: npx solc --optimize contracts/HoneypotProbe.sol (see the .sol header).
//
// Cost: 1 RPC eth_call per token that already passed the tier gates.

/** Synthetic address the probe contract is injected onto (never deployed). */
const PROBE_ADDRESS = '0x00000000000000000000000000000000DeaDBeef'

/** ETH amount (wei) to simulate the buy with. Small enough to barely move any pool. */
const PROBE_AMOUNT_WEI = 10_000_000_000_000_000n // 0.01 ETH

/** Balance injected onto the probe address — trade amount plus headroom for gas math. */
const PROBE_BALANCE_WEI = PROBE_AMOUNT_WEI * 3n

const CACHE_PREFIX = 'honeypot:'
const CACHE_TTL_S = 120
const CALL_TIMEOUT_MS = 4_000

// Runtime bytecode of HoneypotProbe (solc 0.8.36, optimizer runs=200).
// Keep in sync with contracts/HoneypotProbe.sol.
const PROBE_RUNTIME_BYTECODE =
  "0x" +
  "608060405260043610610020575f3560e01c80635a7b82681461002b575f5ffd5b3661002757" +
  "005b5f5ffd5b348015610036575f5ffd5b5061004a6100453660046104e8565b61006e565b60" +
  "408051948552602085019390935291830152606082015260800160405180910390f35b5f8080" +
  "808781600260405190808252806020026020018201604052801561009f578160200160208202" +
  "803683370190505b50905088815f815181106100b5576100b5610544565b6020026020010190" +
  "6001600160a01b031690816001600160a01b03168152505087816001815181106100e9576100" +
  "e9610544565b6001600160a01b03928316602091820292909201015260405163d06ca61f60e0" +
  "1b81525f9184169063d06ca61f90610127908b90869060040161059b565b5f60405180830381" +
  "865afa158015610141573d5f5f3e3d5ffd5b505050506040513d5f823e601f3d908101601f19" +
  "16820160405261016891908101906105bb565b905080600182516101799190610683565b8151" +
  "811061018957610189610544565b60200260200101519650826001600160a01b0316637ff36a" +
  "b5895f85305f196040518663ffffffff1660e01b81526004016101c794939291906106a8565b" +
  "5f6040518083038185885af11580156101e2573d5f5f3e3d5ffd5b50505050506040513d5f82" +
  "3e601f3d908101601f1916820160405261020a91908101906105bb565b506040516370a08231" +
  "60e01b81523060048201526001600160a01b038a16906370a082319060240160206040518083" +
  "0381865afa15801561024d573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201" +
  "806040525081019061027191906106dc565b95505f86116102c65760405162461bcd60e51b81" +
  "5260206004820152601b60248201527f70726f62653a207a65726f20746f6b656e7320726563" +
  "65697665640000000000604482015260640160405180910390fd5b60405163095ea7b360e01b" +
  "81526001600160a01b038c81166004830152602482018890528a169063095ea7b39060440160" +
  "20604051808303815f875af1158015610312573d5f5f3e3d5ffd5b505050506040513d601f19" +
  "601f8201168201806040525081019061033691906106f3565b50604080516002808252606082" +
  "0183525f9260208301908036833701905050905089815f8151811061036a5761036a61054456" +
  "5b60200260200101906001600160a01b031690816001600160a01b0316815250508a81600181" +
  "51811061039e5761039e610544565b6001600160a01b03928316602091820292909201015260" +
  "405163d06ca61f60e01b81525f9186169063d06ca61f906103dc908b90869060040161059b56" +
  "5b5f60405180830381865afa1580156103f6573d5f5f3e3d5ffd5b505050506040513d5f823e" +
  "601f3d908101601f1916820160405261041d91908101906105bb565b9050806001825161042e" +
  "9190610683565b8151811061043e5761043e610544565b602002602001015196505f47905085" +
  "6001600160a01b031663791ac9478a5f86305f196040518663ffffffff1660e01b8152600401" +
  "610481959493929190610719565b5f604051808303815f87803b158015610498575f5ffd5b50" +
  "5af11580156104aa573d5f5f3e3d5ffd5b5050505080476104ba9190610683565b9650505050" +
  "505050945094509450949050565b80356001600160a01b03811681146104e3575f5ffd5b9190" +
  "50565b5f5f5f5f608085870312156104fb575f5ffd5b610504856104cd565b93506105126020" +
  "86016104cd565b9250610520604086016104cd565b9396929550929360600135925050565b63" +
  "4e487b7160e01b5f52604160045260245ffd5b634e487b7160e01b5f52603260045260245ffd" +
  "5b5f8151808452602084019350602083015f5b828110156105915781516001600160a01b0316" +
  "86526020958601959091019060010161056a565b5093949350505050565b8281526040602082" +
  "01525f6105b36040830184610558565b949350505050565b5f602082840312156105cb575f5f" +
  "fd5b815167ffffffffffffffff8111156105e1575f5ffd5b8201601f810184136105f1575f5f" +
  "fd5b805167ffffffffffffffff81111561060b5761060b610530565b8060051b604051601f19" +
  "603f830116810181811067ffffffffffffffff8211171561063857610638610530565b604052" +
  "918252602081840181019290810187841115610655575f5ffd5b6020850194505b8385101561" +
  "06785784518082526020958601959093500161065c565b509695505050505050565b81810381" +
  "8111156106a257634e487b7160e01b5f52601160045260245ffd5b92915050565b8481526080" +
  "60208201525f6106c06080830186610558565b6001600160a01b039490941660408301525060" +
  "60015292915050565b5f602082840312156106ec575f5ffd5b5051919050565b5f6020828403" +
  "1215610703575f5ffd5b81518015158114610712575f5ffd5b9392505050565b858152846020" +
  "82015260a060408201525f61073760a0830186610558565b6001600160a01b03949094166060" +
  "8301525060800152939250505056fea26469706673582212209dab178c312e6910f2acbd34e6" +
  "cfed05a2dcdb82d947664991006b04ae8d0c5464736f6c63430008240033"

const probeIface = new Interface([
  'function probe(address router, address weth, address token, uint256 amountIn) returns (uint256 tokensQuoted, uint256 tokensReceived, uint256 ethQuoted, uint256 ethReceived)',
])

export interface HoneypotResult {
  /** true = round trip succeeded (buy + sell both went through). false = honeypot / not sellable. */
  ok: boolean
  /** Buy-side fee-on-transfer tax, percent (0 = clean). */
  buyTaxPct: number
  /** Sell-side tax, percent. A honeypot typically shows ~100 here or reverts (ok=false). */
  sellTaxPct: number
  /** Fraction of the input ETH recovered after a full buy->sell, percent (~99.4 for a clean token = 2×0.3% Uniswap fee). */
  roundTripPct: number
  /** Set when ok=false: 'revert' (honeypot) or 'rpc-error' (network — caller should fail-closed). */
  error?: 'revert' | 'rpc-error'
}

interface RawProbeOutput {
  tokensQuoted: bigint
  tokensReceived: bigint
  ethQuoted: bigint
  ethReceived: bigint
}

function pct(quoted: bigint, actual: bigint): number {
  if (quoted <= 0n) return 0
  const lostBps = ((quoted - actual) * 10_000n) / quoted
  return Math.max(0, Number(lostBps) / 100)
}

function isRevert(err: unknown): boolean {
  // ethers surfaces contract reverts as CALL_EXCEPTION; the RPC also returns
  // "execution reverted" in the message. Anything else is treated as transient.
  const e = err as { code?: string; message?: string; info?: { error?: { message?: string } } }
  if (e?.code === 'CALL_EXCEPTION') return true
  const msg = (e?.message ?? '').toLowerCase()
  const inner = (e?.info?.error?.message ?? '').toLowerCase()
  return msg.includes('execution reverted') || inner.includes('execution reverted')
}

async function rawProbe(tokenAddress: string): Promise<RawProbeOutput> {
  const data = probeIface.encodeFunctionData('probe', [
    UNISWAP_ROUTER_ADDRESS,
    WETH_ADDRESS,
    tokenAddress,
    PROBE_AMOUNT_WEI,
  ])

  const tx = { to: PROBE_ADDRESS, data }
  const overrides = {
    [PROBE_ADDRESS]: {
      code: PROBE_RUNTIME_BYTECODE,
      balance: '0x' + PROBE_BALANCE_WEI.toString(16),
    },
  }

  const raw = (await Promise.race([
    rhProvider.send('eth_call', [tx, 'latest', overrides]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('probe eth_call timeout')), CALL_TIMEOUT_MS),
    ),
  ])) as string

  const decoded = probeIface.decodeFunctionResult('probe', raw)
  return {
    tokensQuoted: decoded[0] as bigint,
    tokensReceived: decoded[1] as bigint,
    ethQuoted: decoded[2] as bigint,
    ethReceived: decoded[3] as bigint,
  }
}

/**
 * Probe a token for honeypot behavior and fee-on-transfer taxes.
 * Results are cached in Redis for CACHE_TTL_S to avoid re-probing the same
 * token across retries or duplicate candidates.
 */
export async function probeToken(
  tokenAddress: string,
  opts: { fresh?: boolean } = {},
): Promise<HoneypotResult> {
  const cacheKey = `${CACHE_PREFIX}${tokenAddress.toLowerCase()}`

  // Cache lookup (skipped when the caller needs a live verdict, e.g. the
  // position sweep checking whether a held token is STILL sellable)
  if (!opts.fresh) {
    try {
      const cached = await eventBus.client.get(cacheKey)
      if (cached) return JSON.parse(cached) as HoneypotResult
    } catch {
      // Redis hiccup — proceed to live probe
    }
  }

  let result: HoneypotResult
  let attempt = 0
  // One retry, but ONLY for transient/network errors — a revert is a definitive
  // honeypot verdict and must not be retried.
  for (;;) {
    try {
      const out = await rawProbe(tokenAddress)
      const buyTaxPct = pct(out.tokensQuoted, out.tokensReceived)
      const sellTaxPct = pct(out.ethQuoted, out.ethReceived)
      const roundTripPct =
        PROBE_AMOUNT_WEI > 0n
          ? Math.max(0, Number((out.ethReceived * 10_000n) / PROBE_AMOUNT_WEI) / 100)
          : 0
      result = { ok: true, buyTaxPct, sellTaxPct, roundTripPct }
      break
    } catch (err) {
      if (isRevert(err)) {
        log.debug({ tokenAddress, err: (err as Error).message?.slice(0, 120) }, 'Probe reverted — honeypot / not sellable')
        result = { ok: false, buyTaxPct: 100, sellTaxPct: 100, roundTripPct: 0, error: 'revert' }
        break
      }
      // transient error
      if (attempt < 1) {
        attempt++
        log.warn({ tokenAddress, err: (err as Error).message?.slice(0, 120) }, 'Probe RPC error — retrying once')
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      log.warn({ tokenAddress }, 'Probe RPC error after retry — reporting rpc-error (caller fails closed)')
      result = { ok: false, buyTaxPct: 100, sellTaxPct: 100, roundTripPct: 0, error: 'rpc-error' }
      break
    }
  }

  // Cache (revert verdicts too — a honeypot stays a honeypot)
  try {
    await eventBus.client.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_S)
  } catch {
    // non-fatal
  }

  return result
}

/**
 * Convenience predicate: does this probe result clear the configured tax gates?
 * A network error (ok=false, error='rpc-error') is NOT acceptable — fail closed.
 */
export function passesHoneypotGate(r: HoneypotResult): boolean {
  if (!r.ok) return false
  return (
    r.buyTaxPct <= env.HONEYPOT_MAX_BUY_TAX_PCT &&
    r.sellTaxPct <= env.HONEYPOT_MAX_SELL_TAX_PCT
  )
}
