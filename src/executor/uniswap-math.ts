import { Contract, type Provider } from 'ethers'
import { createChildLogger } from '../utils/logger.js'

const log = createChildLogger('uniswap-math')

// ── Uniswap V2 constant-product math (Robinhood Chain / EVM) ──────────────────
// Standard x*y=k AMM with real pair reserves and 0.3% LP fee.
//
// Unlike Pump.fun's bonding curve (virtual 30 ETH, 1% fee, graduation),
// Uniswap V2 uses actual ETH + token reserves deposited by the first LP.
// Fee is 0.3% (30 bps) — deducted from input on each swap.
//
// Reference: https://docs.uniswap.org/contracts/v2/concepts/protocol-overview/how-uniswap-works

export const UNISWAP_FEE_BPS = 30 // 0.30 %

// ── Types ─────────────────────────────────────────────────────────────────────

/** Pair reserves in human-readable units (whole ETH / whole tokens). */
export interface PairState {
  /** ETH reserves in the pair (whole ETH). */
  ethReserve: number
  /** Token reserves in the pair (whole tokens, adjusted by token decimals). */
  tokenReserve: number
  /** Token decimals (fetched from ERC-20 contract). */
  tokenDecimals: number
}

export interface BuyQuote {
  /** ETH spent including fee. */
  nativeIn: number
  /** Tokens received (after applying constant product). */
  tokensOut: number
  /** Fee paid to LP (ETH). */
  feeNative: number
  /** Effective execution price (ETH per token). */
  executionPrice: number
  /** Spot price BEFORE the trade (ETH per token). */
  spotPriceBefore: number
  /** Spot price AFTER the trade (ETH per token). */
  spotPriceAfter: number
  /** Price impact (%) — (executionPrice - spotBefore) / spotBefore × 100. */
  priceImpactPct: number
  /** Pair state after the trade. */
  newState: PairState
}

export interface SellQuote {
  tokensIn: number
  nativeOut: number
  feeNative: number
  executionPrice: number
  spotPriceBefore: number
  spotPriceAfter: number
  priceImpactPct: number
  newState: PairState
}

// ── ABIs ──────────────────────────────────────────────────────────────────────

/** Uniswap V2 Pair ABI — view functions for reading reserves and token info. */
export const UNISWAP_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function totalSupply() external view returns (uint256)',
  'function decimals() external view returns (uint8)',
]

/** Minimal ERC-20 ABI for reading token metadata. */
export const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]

// ── On-chain state fetching ───────────────────────────────────────────────────

/**
 * Raw reserves as returned by `getReserves()` — values in wei / raw token units.
 * Use `normalizeReserves()` to convert to human-readable PairState.
 */
export interface RawPairReserves {
  reserve0: bigint
  reserve1: bigint
  blockTimestampLast: number
}

/**
 * Raw pair info — which token is which, and their decimals.
 */
export interface RawPairInfo {
  token0: string
  token1: string
  decimals0: number
  decimals1: number
}

/**
 * Fetch raw reserves from a Uniswap V2 pair contract.
 * Returns null if the call reverts (pair not found).
 */
export async function getRawPairReserves(
  pairContract: Contract,
): Promise<RawPairReserves | null> {
  try {
    const result = await pairContract.getReserves!()
    // ethers v6 returns a Result object; values are bigint
    const reserve0: bigint = result[0]
    const reserve1: bigint = result[1]
    const blockTimestampLast: number = Number(result[2])

    if (reserve0 === 0n && reserve1 === 0n) {
      log.warn({ pair: await pairContract.getAddress() }, 'Pair reserves are both zero')
      return null
    }

    return { reserve0, reserve1, blockTimestampLast }
  } catch (err) {
    log.warn({ err }, 'Failed to fetch pair reserves')
    return null
  }
}

/**
 * Fetch token info (token0, token1 addresses + decimals) from a pair contract.
 */
export async function getRawPairInfo(
  pairContract: Contract,
  provider: Provider,
): Promise<RawPairInfo | null> {
  try {
    const [token0, token1] = await Promise.all([
      pairContract.token0!() as Promise<string>,
      pairContract.token1!() as Promise<string>,
    ])

    const [decimals0, decimals1] = await Promise.all([
      getTokenDecimals(token0, provider),
      getTokenDecimals(token1, provider),
    ])

    return { token0, token1, decimals0, decimals1 }
  } catch (err) {
    log.warn({ err }, 'Failed to fetch pair info')
    return null
  }
}

/**
 * Fetch token decimals from an ERC-20 contract.
 * Defaults to 18 if the call fails or the contract doesn't implement decimals().
 */
export async function getTokenDecimals(
  tokenAddress: string,
  provider: Provider,
): Promise<number> {
  try {
    const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider)
    const decimals = await tokenContract.decimals!()
    return Number(decimals)
  } catch {
    log.warn({ token: tokenAddress }, 'Could not fetch decimals, defaulting to 18')
    return 18
  }
}

/**
 * Fetch total supply from an ERC-20 token contract.
 */
export async function getTokenTotalSupply(
  tokenAddress: string,
  provider: Provider,
): Promise<bigint | null> {
  try {
    const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider)
    const supply: bigint = await tokenContract.totalSupply!()
    return supply
  } catch (err) {
    log.warn({ err, token: tokenAddress }, 'Failed to fetch total supply')
    return null
  }
}

/**
 * Normalize raw pair data into a human-readable PairState, identifying which
 * reserve is ETH based on which token matches the WETH address.
 *
 * @param raw - Raw reserves from getReserves()
 * @param info - Raw pair info (token0, token1, decimals)
 * @param wethAddress - WETH address on the chain (lowercase for comparison)
 */
export function normalizeReserves(
  raw: RawPairReserves,
  info: RawPairInfo,
  wethAddress: string,
): PairState {
  const isToken0Eth = info.token0.toLowerCase() === wethAddress.toLowerCase()
  return normalizeReservesFromCache(raw, {
    token0: info.token0,
    token1: info.token1,
    tokenDecimals: isToken0Eth ? info.decimals1 : info.decimals0,
  }, wethAddress, isToken0Eth)
}

/**
 * Immutable pair info snapshot — stored in position metadata at entry to avoid
 * redundant RPC calls for token0/token1 (which never change after pair creation).
 */
export interface CachedPairInfo {
  token0: string
  token1: string
  /** Decimals of the MEMECOIN side (not WETH). */
  tokenDecimals: number
}

/**
 * Normalize raw reserves using a cached immutable pair info snapshot.
 * ZERO RPC calls — token0/token1 are immutable in Uniswap V2 pair contracts.
 *
 * @param raw - Raw reserves from getReserves()
 * @param cached - Cached pair info (token0, token1, memecoin tokenDecimals)
 * @param wethAddress - WETH address on the chain (lowercase for comparison)
 * @param knownIsToken0Eth - Optional pre-computed flag to avoid re-checking
 */
export function normalizeReservesFromCache(
  raw: RawPairReserves,
  cached: CachedPairInfo,
  wethAddress: string,
  knownIsToken0Eth?: boolean,
): PairState {
  const isToken0Eth = knownIsToken0Eth ?? (
    cached.token0.toLowerCase() === wethAddress.toLowerCase()
  )

  const ethReserveRaw = isToken0Eth ? raw.reserve0 : raw.reserve1
  const tokenReserveRaw = isToken0Eth ? raw.reserve1 : raw.reserve0

  return {
    ethReserve: Number(ethReserveRaw) / 1e18,
    tokenReserve: Number(tokenReserveRaw) / 10 ** cached.tokenDecimals,
    tokenDecimals: cached.tokenDecimals,
  }
}

/**
 * WETH-side reserve of a pair in whole ETH, from raw event fields.
 * Returns 0 when the ordering or reserves are unknown — callers treat 0 as
 * "liquidity not yet available". Never returns the token-side reserve.
 */
export function ethSideReserveNative(
  fields: {
    token0?: string | undefined
    token1?: string | undefined
    reserve0?: string | undefined
    reserve1?: string | undefined
  },
  wethAddress: string,
): number {
  const { token0, token1, reserve0, reserve1 } = fields
  if (!token0 || !token1 || !reserve0 || !reserve1) return 0

  const wethLower = wethAddress.toLowerCase()
  let raw: string
  if (token0.toLowerCase() === wethLower) raw = reserve0
  else if (token1.toLowerCase() === wethLower) raw = reserve1
  else return 0

  const eth = parseFloat(raw) / 1e18
  return Number.isFinite(eth) && eth > 0 ? eth : 0
}

// ── Quote functions ───────────────────────────────────────────────────────────

/**
 * Quote a BUY against the current Uniswap V2 pair state.
 *
 * Math (standard Uniswap V2 x*y=k with 0.3% fee):
 *   k = ethReserve * tokenReserve
 *   ethInEffective = ethIn * (1 - fee)    // 0.3% fee deducted
 *   newEthReserve = ethReserve + ethInEffective
 *   newTokenReserve = k / newEthReserve
 *   tokensOut = tokenReserve - newTokenReserve
 *
 * @param state - Current pair state (in whole units)
 * @param nativeIn - ETH to spend (whole ETH)
 */
export function quoteBuy(state: PairState, nativeIn: number): BuyQuote {
  if (nativeIn <= 0) throw new Error(`nativeIn must be positive (got ${nativeIn})`)
  if (state.ethReserve <= 0 || state.tokenReserve <= 0) {
    throw new Error('pair reserves must be positive')
  }

  const fee = nativeIn * (UNISWAP_FEE_BPS / 10_000)
  const nativeInEffective = nativeIn - fee

  const k = state.ethReserve * state.tokenReserve
  const newEthReserve = state.ethReserve + nativeInEffective
  const newTokenReserve = k / newEthReserve
  const tokensOut = state.tokenReserve - newTokenReserve

  const spotPriceBefore = state.ethReserve / state.tokenReserve
  const spotPriceAfter = newEthReserve / newTokenReserve
  const executionPrice = nativeIn / tokensOut
  const priceImpactPct = ((executionPrice - spotPriceBefore) / spotPriceBefore) * 100

  return {
    nativeIn,
    tokensOut,
    feeNative: fee,
    executionPrice,
    spotPriceBefore,
    spotPriceAfter,
    priceImpactPct,
    newState: { ethReserve: newEthReserve, tokenReserve: newTokenReserve, tokenDecimals: state.tokenDecimals },
  }
}

/**
 * Quote a SELL — symmetric to buy. Returns ETH received for tokensIn.
 *
 * Math:
 *   k = ethReserve * tokenReserve
 *   newTokenReserve = tokenReserve + tokensIn
 *   newEthReserve = k / newTokenReserve
 *   ethOutGross = ethReserve - newEthReserve
 *   fee = ethOutGross * (feeBps / 10000)
 *   ethOut = ethOutGross - fee
 */
export function quoteSell(state: PairState, tokensIn: number): SellQuote {
  if (tokensIn <= 0) throw new Error(`tokensIn must be positive (got ${tokensIn})`)

  const k = state.ethReserve * state.tokenReserve
  const newTokenReserve = state.tokenReserve + tokensIn
  const newEthReserve = k / newTokenReserve
  const nativeOutGross = state.ethReserve - newEthReserve
  const fee = nativeOutGross * (UNISWAP_FEE_BPS / 10_000)
  const nativeOut = nativeOutGross - fee

  const spotPriceBefore = state.ethReserve / state.tokenReserve
  const spotPriceAfter = newEthReserve / newTokenReserve
  const executionPrice = nativeOut / tokensIn
  const priceImpactPct = ((spotPriceBefore - executionPrice) / spotPriceBefore) * 100

  return {
    tokensIn,
    nativeOut,
    feeNative: fee,
    executionPrice,
    spotPriceBefore,
    spotPriceAfter,
    priceImpactPct,
    newState: { ethReserve: newEthReserve, tokenReserve: newTokenReserve, tokenDecimals: state.tokenDecimals },
  }
}

// ── Market cap calculation ────────────────────────────────────────────────────

/**
 * Calculate market cap in USD from pair reserves and total supply.
 *
 * Price = ethReserve / tokenReserve  (spot price in ETH per token)
 * MarketCap_ETH = price * totalSupply
 * MarketCap_USD = MarketCap_ETH * ethPriceUSD
 *
 * @param state - Current pair state (in whole units)
 * @param totalSupply - Token total supply (raw bigint from ERC-20)
 * @param ethPriceUSD - Current ETH price in USD (defaults to a rough estimate)
 */
export function getMarketCapUSD(
  state: PairState,
  totalSupply: bigint,
  ethPriceUSD: number = 3000,
): number {
  if (state.tokenReserve <= 0) return 0

  const priceInEth = state.ethReserve / state.tokenReserve
  const totalSupplyWhole = Number(totalSupply) / 10 ** state.tokenDecimals
  const marketCapEth = priceInEth * totalSupplyWhole

  return Math.round(marketCapEth * ethPriceUSD)
}

/**
 * Shorthand: compute market cap USD directly from raw pair reserves.
 * Convenience function that normalizes reserves internally.
 */
export function getMarketCapUSDFromRaw(
  raw: RawPairReserves,
  info: RawPairInfo,
  wethAddress: string,
  totalSupply: bigint,
  ethPriceUSD: number = 3000,
): number {
  const state = normalizeReserves(raw, info, wethAddress)
  return getMarketCapUSD(state, totalSupply, ethPriceUSD)
}

// ── Conversion helpers ────────────────────────────────────────────────────────

/**
 * Convert a human-readable token amount to raw wei/token-units.
 * Uses the token's decimals for precision.
 */
export function tokensToRaw(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals))
}

/**
 * Convert raw token units to a human-readable number.
 */
export function tokensFromRaw(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals
}

/**
 * Convert ETH amount to wei.
 */
export function ethToWei(eth: number): bigint {
  return BigInt(Math.floor(eth * 1e18))
}

/**
 * Convert wei to ETH.
 */
export function weiToEth(wei: bigint): number {
  return Number(wei) / 1e18
}
