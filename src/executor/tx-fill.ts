import type { TransactionReceipt } from 'ethers'

// ── On-chain fill extraction (EVM / Robinhood Chain) ─────────────────────────
// The AMM quote is only an ESTIMATE. What actually landed on-chain can differ
// (front-runs, other swaps in the same block, fee-on-transfer taxes, rounding).
// To report PnL that matches the real wallet balance — and to record a token
// amount the sell path can actually spend — we read the confirmed receipt's
// logs instead of trusting the pre-trade quote:
//
//   • Tokens received/sent: net of the token's ERC-20 Transfer events touching
//     the owner. For fee-on-transfer tokens this is the post-tax amount.
//   • ETH received on a sell: the WETH Withdrawal event the router emits when
//     it unwraps WETH before forwarding ETH to the recipient
//     (swapExactTokensForETH* always ends with WETH.withdraw(amountOut)).
//
// Pure + side-effect free → unit-testable without a live RPC (tests/unit/tx-fill.test.ts).

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' // keccak Transfer(address,address,uint256)
const WETH_WITHDRAWAL_TOPIC =
  '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65' // keccak Withdrawal(address,uint256)

export interface TxFill {
  /** Gas fee paid in wei (gasUsed × effectiveGasPrice). */
  gasFeeWei: bigint
  /**
   * Net token change for (owner, tokenAddress), in raw units.
   * Positive on a buy, negative on a sell. `null` when no Transfer event of the
   * token touched the owner (caller should fall back to the quote).
   */
  tokenDeltaRaw: bigint | null
  /**
   * Total WETH unwrapped in the transaction (wei) — on a Router02 ETH-out swap
   * this equals the ETH forwarded to the recipient. `null` when the tx emitted
   * no WETH Withdrawal (e.g. a buy, or a non-router path).
   */
  wethWithdrawnWei: bigint | null
}

/**
 * Extract the owner's token delta and the unwrapped-ETH amount from a confirmed
 * transaction receipt. Returns `null` only when the receipt itself is unusable —
 * callers then fall back to the pre-trade quote estimate.
 */
export function extractTxFill(
  receipt: TransactionReceipt | null | undefined,
  owner: string,
  tokenAddress: string,
  wethAddress: string,
): TxFill | null {
  if (!receipt || !receipt.logs) return null
  if (typeof receipt.gasUsed !== 'bigint' || typeof receipt.gasPrice !== 'bigint') return null

  const ownerLower = owner.toLowerCase()
  const tokenLower = tokenAddress.toLowerCase()
  const wethLower = wethAddress.toLowerCase()

  const gasFeeWei = receipt.gasUsed * receipt.gasPrice

  let tokenDeltaRaw: bigint | null = null
  let wethWithdrawnWei: bigint | null = null

  for (const log of receipt.logs) {
    const logAddress = log.address.toLowerCase()
    const topic0 = log.topics[0]?.toLowerCase()

    // ERC-20 Transfer on the traded token, touching the owner
    if (logAddress === tokenLower && topic0 === ERC20_TRANSFER_TOPIC) {
      const from = decodeAddress(log.topics[1])
      const to = decodeAddress(log.topics[2])
      const value = BigInt(log.data)

      if (from.toLowerCase() === ownerLower) {
        tokenDeltaRaw = (tokenDeltaRaw ?? 0n) - value
      }
      if (to.toLowerCase() === ownerLower) {
        tokenDeltaRaw = (tokenDeltaRaw ?? 0n) + value
      }
      continue
    }

    // WETH Withdrawal — router unwrapping the swap output before sending ETH
    if (logAddress === wethLower && topic0 === WETH_WITHDRAWAL_TOPIC) {
      wethWithdrawnWei = (wethWithdrawnWei ?? 0n) + BigInt(log.data)
    }
  }

  return { gasFeeWei, tokenDeltaRaw, wethWithdrawnWei }
}

/**
 * Decode an indexed address from a 32-byte topic.
 * ERC-20 Transfer topics are 32-byte padded: the address fills the last 20 bytes.
 */
function decodeAddress(topic: string | undefined | null): string {
  if (!topic || topic.length < 66) return '0x0000000000000000000000000000000000000000'
  return '0x' + topic.slice(26) // last 20 bytes = 40 hex chars
}

/**
 * Actual ETH received on a SELL, in wei — the WETH the router unwrapped.
 * Falls back to the quote estimate if the fill is missing or non-positive.
 */
export function realizedEthOutWei(fill: TxFill | null, fallbackWei: bigint): bigint {
  if (!fill || fill.wethWithdrawnWei === null) return fallbackWei
  return fill.wethWithdrawnWei > 0n ? fill.wethWithdrawnWei : fallbackWei
}

/**
 * Actual tokens received on a BUY, in raw units — the net Transfer delta.
 * Falls back to the quote estimate if the fill is missing or non-positive.
 */
export function realizedTokensRaw(fill: TxFill | null, fallbackRaw: bigint): bigint {
  if (!fill || fill.tokenDeltaRaw === null) return fallbackRaw
  return fill.tokenDeltaRaw > 0n ? fill.tokenDeltaRaw : fallbackRaw
}
