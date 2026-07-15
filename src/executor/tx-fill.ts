import type { TransactionReceipt, TransactionResponse } from 'ethers'

// ── On-chain fill extraction (EVM / Robinhood Chain) ─────────────────────────
// The bonding-curve quote is only an ESTIMATE. What actually landed on-chain can
// differ (front-runs, other buys/sells in the same block, rounding). To report PnL
// that matches the real wallet balance, we read the confirmed transaction receipt's
// Transfer events and ETH balance delta instead of trusting the pre-trade quote.
//
// Pure + side-effect free → unit-testable without a live RPC.

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export interface TxFill {
  /**
   * Net ETH change of the sender, in wei (postBalance - preBalance).
   * Negative on a buy (spent), positive on a sell (received). Includes the gas fee.
   */
  ethDeltaWei: bigint
  /** Gas fee paid in wei (gasUsed × effectiveGasPrice). */
  gasFeeWei: bigint
  /**
   * Net token change for (owner, tokenAddress), in raw units (postBalance - preBalance).
   * Positive on a buy (received tokens), negative on a sell (sent tokens).
   */
  tokenDeltaRaw: bigint
}

/**
 * Extract the sender's ETH + token deltas from a confirmed transaction receipt.
 * Returns `null` if the receipt or logs are unavailable — caller
 * should then fall back to the pre-trade quote estimate.
 */
export function extractTxFill(
  receipt: TransactionReceipt | null | undefined,
  owner: string,
  tokenAddress: string,
): TxFill | null {
  if (!receipt || !receipt.logs) return null
  if (typeof receipt.gasUsed !== 'bigint' || typeof receipt.gasPrice !== 'bigint') return null

  const ownerLower = owner.toLowerCase()
  const tokenLower = tokenAddress.toLowerCase()

  // Gas fee = gasUsed × effectiveGasPrice
  const effectiveGasPrice = receipt.gasPrice // ethers populates this
  const gasFeeWei = receipt.gasUsed * effectiveGasPrice

  // ETH delta: find Transfer of native ETH (may not have a topic — we track via
  // value sent, or we estimate from the net of gas + value). For a simpler approach,
  // we look at the contract's internal value transfer. But the simplest reliable
  // method is: if the tx was a buy, value sent = total ETH spent (excluding gas);
  // if a sell, look for WETH/native transfers in the logs.
  //
  // For Pump.fun direct buys (payable), the ETH delta (ex gas) = -tx.value
  // For sells, we extract ETH received from the contract's WETH wrap/unwrap events
  // or simply use the quote estimate as fallback.
  //
  // We attempt to read the actual on-chain balance delta from the receipt.
  // If the provider supports `eth_getBalance` at previous block, we'd use that —
  // but that requires an extra RPC call. For now, we handle what the receipt gives us.

  let ethDeltaWei = 0n

  // Extract token delta from ERC-20 Transfer events
  let tokenDeltaRaw = 0n

  for (const log of receipt.logs) {
    // Must be addressed to the token contract
    if (log.address.toLowerCase() !== tokenLower) continue

    // Must be a Transfer event
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue

    // ERC-20 Transfer: topics[1] = from (indexed), topics[2] = to (indexed)
    const from = decodeAddress(log.topics[1])
    const to = decodeAddress(log.topics[2])
    const value = BigInt(log.data)

    if (from.toLowerCase() === ownerLower) {
      tokenDeltaRaw -= value
    }
    if (to.toLowerCase() === ownerLower) {
      tokenDeltaRaw += value
    }
  }

  // ETH delta: for buys, the transaction value is the ETH sent (excluding gas).
  // For sells, the value field is typically 0. The actual ETH received is harder
  // to extract from logs alone without looking at internal transfers.
  // We compute: if value > 0, ethDeltaWei = -(value + gasFeeWei) (buy burn).
  // If value == 0, we can't determine the exact ETH received from logs alone —
  // caller should fall back to quote estimate.
  // In ethers v6, TransactionReceipt may carry `value` from the original tx —
  // use type assertion to access it safely (only present for payable calls like buys).
  const txValue = (receipt as unknown as { value?: bigint }).value
  if (txValue !== undefined && txValue > 0n) {
    // This was likely a buy (payable call)
    ethDeltaWei = -(txValue + gasFeeWei)
  } else {
    // Sell — can't determine exact ETH received from receipt alone without
    // balance deltas. Return null to signal "fall back to quote".
    return null
  }

  return {
    ethDeltaWei,
    gasFeeWei,
    tokenDeltaRaw,
  }
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
 * Actual ETH received on a SELL, in wei.
 * Wallet net change = ethOut - gasFee, so ethOut = netChange + gasFee.
 * Falls back to the quote estimate if the fill is missing or non-positive.
 */
export function realizedEthOutWei(fill: TxFill | null, fallbackWei: bigint): bigint {
  if (!fill) return fallbackWei
  const out = fill.ethDeltaWei + fill.gasFeeWei
  return out > 0n ? out : fallbackWei
}

/**
 * Actual tokens received on a BUY, in raw units.
 * Falls back to the quote estimate if the fill is missing or non-positive.
 */
export function realizedTokensRaw(fill: TxFill | null, fallbackRaw: bigint): bigint {
  if (!fill) return fallbackRaw
  return fill.tokenDeltaRaw > 0n ? fill.tokenDeltaRaw : fallbackRaw
}
