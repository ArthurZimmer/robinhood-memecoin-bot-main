import { randomUUID } from 'node:crypto'
import { Contract } from 'ethers'
import { createChildLogger } from '../utils/logger.js'
import { env } from '../config/env.js'
import { sendTelegramAlert } from '../utils/telegram.js'
import { rhProvider, WETH_ADDRESS } from '../utils/robbinhood.utils.js'
import { probeToken } from '../risk/honeypot-probe.js'
import {
  insertPaperTrade,
  insertPosition,
  findOpenPositionByToken,
  markPartialExit,
  closePosition,
} from '../positions/position.repository.js'
import { eventBus } from '../events/event-bus.js'
import {
  quoteBuy,
  quoteSell,
  getRawPairReserves,
  normalizeReservesFromCache,
  UNISWAP_PAIR_ABI,
  type PairState,
} from './uniswap-math.js'
import type { BaseExecutor, ExecutionResult } from './base.executor.js'
import type { TradeSignal, PoolCreatedEvent } from '../events/event-types.js'
import type { Position } from '../database/schema.js'

const log = createChildLogger('paper-executor')

// Default token decimals — paper mode doesn't call on-chain, so we default to 18.
// The source event may carry tokenDecimals from the parser, which takes priority.
const DEFAULT_TOKEN_DECIMALS = 18

// ── Gas realism ───────────────────────────────────────────────────────────────
// Real trades pay gas; paper subtracts the same estimate from realized PnL.
// Units approximate typical V2 swaps (real mode caps at 400k/300k limits).
const BUY_GAS_UNITS = 160_000n // swapExactETHForTokens
const SELL_GAS_UNITS = 210_000n // approve + swapExactTokensForETHSupportingFeeOnTransferTokens
const FALLBACK_GAS_PRICE_WEI = 1_000_000_000n // 1 gwei
const GAS_PRICE_CACHE_MS = 60_000

let gasPriceCache: { priceWei: bigint; fetchedAt: number } | null = null

async function currentGasPriceWei(): Promise<bigint> {
  const now = Date.now()
  if (gasPriceCache && now - gasPriceCache.fetchedAt < GAS_PRICE_CACHE_MS) {
    return gasPriceCache.priceWei
  }
  try {
    const fee = await rhProvider.getFeeData()
    const priceWei = fee.gasPrice ?? fee.maxFeePerGas ?? FALLBACK_GAS_PRICE_WEI
    gasPriceCache = { priceWei, fetchedAt: now }
    return priceWei
  } catch {
    return gasPriceCache?.priceWei ?? FALLBACK_GAS_PRICE_WEI
  }
}

function gasNative(units: bigint, priceWei: bigint): number {
  return Number(units * priceWei) / 1e18
}

// ── Sell request ─────────────────────────────────────────────────────────────
// Position Manager builds this and calls executor.sell() directly.

export type SellReason =
  | 'take-profit'
  | 'stop-loss'
  | 'manual'
  | 'shutdown'
  | 'stale-flat' // Position dormant — no volume, frees up cap slot
  | 'dev-sell' // Dev wallet dumped > threshold — emergency rug-pull abandon

export interface PaperSellRequest {
  position: Position
  sellPctOfPosition: number // 50 = sell half, 100 = sell all
  reason: SellReason
  currentState: PairState
}

export class PaperExecutor implements BaseExecutor {
  readonly mode = 'paper' as const

  async execute(signal: TradeSignal): Promise<ExecutionResult> {
    const startedAt = Date.now()
    const lockKey = `buy_lock:${signal.tokenAddress}`

    if (signal.action !== 'buy') {
      return this.fail(startedAt, 'paper executor MVP supports buy only')
    }

    // ── Input validation ────────────────────────────────────────────────────
    if (signal.amountNative <= 0) {
      return this.fail(startedAt, `invalid amountNative: ${signal.amountNative}`)
    }
    if (signal.amountNative > 10) {
      return this.fail(
        startedAt,
        `amountNative ${signal.amountNative} exceeds sanity limit of 10 ETH`,
      )
    }

    // ── Redis atomic lock: prevents concurrent duplicate buys ────────────────
    const acquired = await eventBus.client.set(
      lockKey,
      signal.signalId,
      'EX',
      60,
      'NX',
    )
    if (!acquired) {
      return this.fail(
        startedAt,
        `duplicate buy prevented: lock held for ${signal.tokenAddress}`,
      )
    }

    try {
      // Idempotency: refuse double-buy on the same token if a paper position is already open
      const existing = await findOpenPositionByToken(
        'paper',
        signal.tokenAddress,
      )
      if (existing) {
        return this.fail(
          startedAt,
          `position already open for ${signal.tokenAddress}`,
        )
      }

      // Extract pair state from source event (carried through from listener payload)
      const source = signal.opportunity.sourceEvent as PoolCreatedEvent
      const pair = this.extractPairState(source)
      if (!pair) {
        return this.fail(
          startedAt,
          `missing pair reserves on source event for ${signal.tokenAddress}`,
        )
      }

      // Quote the buy via Uniswap V2 constant-product math
      let quote: ReturnType<typeof quoteBuy>
      try {
        quote = quoteBuy(pair, signal.amountNative)
      } catch (err) {
        return this.fail(
          startedAt,
          `quoteBuy failed: ${(err as Error).message}`,
        )
      }

      // ── Math consistency validations ──────────────────────────────────────
      // Guard against bugs in the Uniswap V2 math implementation.
      const sanityError = this.validateBuyQuote(quote, pair, signal.amountNative)
      if (sanityError) {
        return this.fail(startedAt, `quote sanity check failed: ${sanityError}`)
      }

      // Slippage gate — reject if price impact exceeds signal tolerance
      const slippageTolPct = signal.slippageBps / 100
      if (quote.priceImpactPct > slippageTolPct) {
        return this.fail(
          startedAt,
          `price impact ${quote.priceImpactPct.toFixed(2)}% > tolerance ${slippageTolPct.toFixed(2)}%`,
        )
      }

      // ── Simulated inclusion latency — re-quote on live reserves ─────────────
      // A real tx lands blocks after signing; other swaps move the price in
      // between. Wait PAPER_LATENCY_MS, fill at the CURRENT reserves, and
      // enforce the same minOut a real router call would (fail = tx reverted).
      const minTokensOut = quote.tokensOut * (1 - signal.slippageBps / 10_000)
      let fillQuote = quote
      let fillSource: 'live-requote' | 'signal-reserves' = 'signal-reserves'
      const liveState = await this.refetchPairState(
        signal.poolAddress,
        { token0: source.token0, token1: source.token1 },
        pair.tokenDecimals,
      )
      if (liveState) {
        let requote: ReturnType<typeof quoteBuy>
        try {
          requote = quoteBuy(liveState, signal.amountNative)
        } catch (err) {
          return this.fail(
            startedAt,
            `tx reverted: pair state degraded during latency — ${(err as Error).message}`,
          )
        }
        if (requote.tokensOut < minTokensOut) {
          return this.fail(
            startedAt,
            `tx reverted (slippage protection): tokensOut ${requote.tokensOut.toFixed(2)} < minOut ` +
              `${minTokensOut.toFixed(2)} after ${env.PAPER_LATENCY_MS}ms latency`,
          )
        }
        const requoteSanityError = this.validateBuyQuote(requote, liveState, signal.amountNative)
        if (requoteSanityError) {
          return this.fail(startedAt, `requote sanity check failed: ${requoteSanityError}`)
        }
        fillQuote = requote
        fillSource = 'live-requote'
      }

      // ── Gas realism — estimate the gas a real buy tx would burn ─────────────
      const buyGasNative = gasNative(BUY_GAS_UNITS, await currentGasPriceWei())

      // ── Apply honeypot-probe buy tax (fee-on-transfer) ───────────────────────
      // The AMM quote assumes an honest token. Real fee-on-transfer tokens credit
      // fewer tokens than quoted. Applying the measured tax keeps paper metrics
      // honest vs. what real mode would realize (and models the instant drag of a
      // taxed token as a slightly-negative starting PnL).
      const buyTaxPct = signal.honeypotProbe?.buyTaxPct ?? 0
      const effectiveTokensOut = fillQuote.tokensOut * (1 - buyTaxPct / 100)
      if (effectiveTokensOut <= 0) {
        return this.fail(startedAt, `buy tax ${buyTaxPct}% left zero tokens`)
      }
      const effectiveExecutionPrice = signal.amountNative / effectiveTokensOut

      // Persist position + paper trade atomically (best-effort — DB call sequence)
      const txSignature = `paper:${randomUUID()}`
      const tokenDecimals = pair.tokenDecimals

      const position = await insertPosition({
        tokenAddress: signal.tokenAddress,
        ...(source.tokenMetadata?.name && {
          tokenName: source.tokenMetadata.name,
        }),
        ...(source.tokenMetadata?.symbol && {
          tokenSymbol: source.tokenMetadata.symbol,
        }),
        poolAddress: signal.poolAddress,
        protocol: signal.protocol,
        mode: 'paper',
        status: 'open',
        entryPriceNative: effectiveExecutionPrice.toFixed(12),
        entryAmountNative: signal.amountNative.toFixed(9),
        entryTxHash: txSignature,
        tokensReceived: this.tokensToRawString(effectiveTokensOut, tokenDecimals),
        takeProfitPct: env.TAKE_PROFIT_PCT.toFixed(4),
        sellPctAtTp: env.SELL_PCT_AT_TP.toFixed(4),
        stopLossPct: env.STOP_LOSS_PCT.toFixed(4),
        strategyName: signal.strategy,
        signalId: signal.signalId,
        riskScore: signal.opportunity.risk.riskScore,
        riskLevel: signal.opportunity.risk.riskLevel,
        riskFlags: signal.opportunity.risk.flags,
        metadata: {
          spotPriceBefore: fillQuote.spotPriceBefore,
          spotPriceAfter: fillQuote.spotPriceAfter,
          feeNative: fillQuote.feeNative,
          priceImpactPct: fillQuote.priceImpactPct,
          gasSpentNative: buyGasNative,
          pairReservesSnapshot: {
            ethReserve: (liveState ?? pair).ethReserve,
            tokenReserve: (liveState ?? pair).tokenReserve,
          },
          tokenDecimals: pair.tokenDecimals,
          // Immutable pair info — cached to avoid RPC calls for token0/token1
          // on every block during position monitoring.
          token0: source.token0,
          token1: source.token1,
          isToken0Eth: (source.token0 ?? '').toLowerCase() === WETH_ADDRESS.toLowerCase(),
          totalSupply: source.totalSupply,
          deployerAddress: signal.opportunity.deployerAddress,
          // Honeypot probe taxes — sell tax is read back at exit time.
          ...(signal.honeypotProbe && { honeypotProbe: signal.honeypotProbe }),
        },
      })

      await insertPaperTrade({
        positionId: position.id,
        tokenAddress: signal.tokenAddress,
        side: 'buy',
        quotedPriceNative: effectiveExecutionPrice.toFixed(12),
        amountNative: signal.amountNative.toFixed(9),
        tokensAmount: this.tokensToRawString(effectiveTokensOut, tokenDecimals),
        slippageBps: signal.slippageBps,
        priceImpactPct: fillQuote.priceImpactPct.toFixed(4),
        quoteSnapshot: {
          source: 'uniswap-v2-pair',
          fillSource,
          latencyMs: env.PAPER_LATENCY_MS,
          gasNative: buyGasNative,
          spotPriceBefore: fillQuote.spotPriceBefore,
          spotPriceAfter: fillQuote.spotPriceAfter,
          feeNative: fillQuote.feeNative,
          newReserves: {
            ethReserve: fillQuote.newState.ethReserve,
            tokenReserve: fillQuote.newState.tokenReserve,
          },
        },
      })

      const durationMs = Date.now() - startedAt

      log.info(
        {
          positionId: position.id,
          symbol: source.tokenMetadata?.symbol ?? '?',
          tokenAddress: signal.tokenAddress,
          // Entry context — why did the bot buy this token?
          riskScore: signal.opportunity.risk.riskScore,
          riskLevel: signal.opportunity.risk.riskLevel,
          // Execution details
          amountNative: signal.amountNative,
          tokensReceived: effectiveTokensOut.toFixed(2),
          executionPrice: effectiveExecutionPrice.toExponential(4),
          buyTaxPct: buyTaxPct.toFixed(2),
          entryMCNative: (fillQuote.spotPriceBefore * Number(source.totalSupply ?? 0) / 10 ** tokenDecimals).toFixed(2),
          priceImpactPct: fillQuote.priceImpactPct.toFixed(3),
          feeNative: fillQuote.feeNative.toFixed(6),
          gasNative: buyGasNative.toFixed(9),
          fillSource,
          // TP/SL config active for this position
          takeProfitPct: env.TAKE_PROFIT_PCT,
          stopLossPct: env.STOP_LOSS_PCT,
          durationMs,
        },
        'BUY_EXECUTED',
      )

      // Telegram notification (fire-and-forget)
      {
        const tokenLabel = source.tokenMetadata?.symbol ?? signal.tokenAddress.slice(0, 10)
        const totalSupplyNum = source.totalSupply ? Number(source.totalSupply) / 10 ** tokenDecimals : 1_000_000_000
        const mcUsdApprox = (fillQuote.executionPrice * totalSupplyNum).toFixed(2)
        void sendTelegramAlert(
          `🟢 <b>BUY</b> — ${tokenLabel}\n\n` +
            `Spent: <b>${signal.amountNative.toFixed(4)} ETH</b>\n` +
            `Got: <b>${effectiveTokensOut.toFixed(2)} tokens</b>${buyTaxPct > 0 ? ` (buy tax ${buyTaxPct.toFixed(1)}%)` : ''}\n` +
            `Price: <b>${effectiveExecutionPrice.toExponential(4)} ETH</b>\n` +
            `MC: ~$${mcUsdApprox}\n` +
            `Pos: <code>${position.id}</code>`,
        )
      }

      return {
        success: true,
        positionId: position.id,
        outputAmount: effectiveTokensOut.toFixed(6),
        executionPrice: effectiveExecutionPrice,
        realizedSlippagePct: fillQuote.priceImpactPct,
        txSignature,
        durationMs,
      }
    } finally {
      // Release lock — failure is non-fatal (60s TTL auto-clears)
      await eventBus.client.del(lockKey).catch(() => {})
    }
  }

  /**
   * Validate buy quote math consistency.
   * Returns error message string if invalid, null if OK.
   *
   * Checks:
   *   - tokensOut > 0
   *   - executionPrice > 0
   *   - priceImpactPct >= 0
   *   - feeNative > 0 (Uniswap always charges 0.3%)
   *   - constant-product preservation: k_before ≈ k_after
   *   - reserve conservation: new ethReserve ≈ old ethReserve + nativeIn - fee
   *     and new tokenReserve ≈ old tokenReserve - tokensOut
   */
  private validateBuyQuote(
    quote: ReturnType<typeof quoteBuy>,
    pair: PairState,
    nativeIn: number,
  ): string | null {
    if (quote.tokensOut <= 0) {
      return `tokensOut must be > 0, got ${quote.tokensOut}`
    }
    if (quote.executionPrice <= 0) {
      return `executionPrice must be > 0, got ${quote.executionPrice}`
    }
    if (quote.priceImpactPct < 0) {
      return `priceImpactPct must be >= 0, got ${quote.priceImpactPct}`
    }
    if (quote.feeNative <= 0) {
      return `feeNative must be > 0 (Uniswap 0.3% fee), got ${quote.feeNative}`
    }

    // Constant-product preservation: k = ethReserve × tokenReserve
    const kBefore = pair.ethReserve * pair.tokenReserve
    const kAfter = quote.newState.ethReserve * quote.newState.tokenReserve
    // Allow 0.01% relative tolerance for floating-point rounding
    const kTolerance = Math.max(kBefore, kAfter) * 1e-4
    if (Math.abs(kBefore - kAfter) > kTolerance) {
      return (
        `constant-product violated: kBefore=${kBefore.toFixed(1)} ` +
        `kAfter=${kAfter.toFixed(1)} diff=${Math.abs(kBefore - kAfter).toFixed(1)}`
      )
    }

    // Reserve conservation: ethReserve + nativeIn ≈ newEthReserve + fee, tokenReserve - tokensOut ≈ newTokenReserve
    const nativeDelta =
      quote.newState.ethReserve - (pair.ethReserve + nativeIn - quote.feeNative)
    const tokenDelta =
      quote.newState.tokenReserve - (pair.tokenReserve - quote.tokensOut)
    const reserveTolerance = Math.max(pair.ethReserve, pair.tokenReserve) * 1e-4
    if (Math.abs(nativeDelta) > reserveTolerance) {
      return (
        `Native reserve conservation violated: expected=${(pair.ethReserve + nativeIn - quote.feeNative).toFixed(6)} ` +
        `actual=${quote.newState.ethReserve.toFixed(6)} delta=${nativeDelta.toFixed(6)}`
      )
    }
    if (Math.abs(tokenDelta) > reserveTolerance) {
      return (
        `token reserve conservation violated: expected=${(pair.tokenReserve - quote.tokensOut).toFixed(6)} ` +
        `actual=${quote.newState.tokenReserve.toFixed(6)} delta=${tokenDelta.toFixed(6)}`
      )
    }

    return null
  }

  // ── Sell ──────────────────────────────────────────────────────────────────
  // Invoked by Position Manager when TP or SL fires. NOT consumed from a stream —
  // direct call because Position Manager owns the lifecycle decision.

  async sell(req: PaperSellRequest): Promise<ExecutionResult> {
    const startedAt = Date.now()

    if (req.sellPctOfPosition <= 0 || req.sellPctOfPosition > 100) {
      return this.failSell(startedAt, `invalid sellPctOfPosition: ${req.sellPctOfPosition}`)
    }
    if (req.position.status === 'closed' || req.position.status === 'stopped') {
      return this.failSell(startedAt, `position already closed (status=${req.position.status})`)
    }

    // Compute tokens to sell from raw tokens_received column
    const totalTokensRaw = req.position.isMoonbag
      ? BigInt(req.position.moonbagTokens ?? '0')
      : BigInt(req.position.tokensReceived ?? '0')

    if (totalTokensRaw === 0n) {
      return this.failSell(startedAt, 'no tokens left in position')
    }

    // raw units → whole tokens (using stored pair decimals)
    const tokenDecimals = req.currentState.tokenDecimals
    const totalTokensWhole = Number(totalTokensRaw) / 10 ** tokenDecimals
    const tokensToSellWhole = totalTokensWhole * (req.sellPctOfPosition / 100)

    // ── Sellability re-probe — dynamic honeypot guard ────────────────────────
    // A token that turned unsellable after entry would revert a real exit; the
    // paper fill must refuse too. Only a definitive revert blocks the sell —
    // transient RPC errors fail open so exits aren't stuck on network blips.
    const probe = await probeToken(req.position.tokenAddress)
    if (!probe.ok && probe.error === 'revert') {
      return this.failSell(
        startedAt,
        'honeypot: sell simulation reverts — token cannot be sold',
      )
    }

    const meta = req.position.metadata as
      | {
          honeypotProbe?: { sellTaxPct?: number }
          token0?: string
          token1?: string
          gasSpentNative?: number
        }
      | null

    // ── Simulated inclusion latency — re-quote on live reserves ─────────────
    const liveState = await this.refetchPairState(
      req.position.poolAddress,
      { token0: meta?.token0, token1: meta?.token1 },
      tokenDecimals,
    )
    const fillState = liveState ?? req.currentState

    let quote: ReturnType<typeof quoteSell>
    try {
      quote = quoteSell(fillState, tokensToSellWhole)
    } catch (err) {
      return this.failSell(startedAt, `quoteSell failed: ${(err as Error).message}`)
    }

    // ── Apply honeypot-probe sell tax (fee-on-transfer) ──────────────────────
    // Sell tax measured at entry is applied to the AMM quote so paper exits
    // reflect the ETH a fee-on-transfer token would actually return.
    const sellTaxPct = meta?.honeypotProbe?.sellTaxPct ?? 0
    const effectiveNativeOut = quote.nativeOut * (1 - sellTaxPct / 100)

    const txSignature = `paper:${randomUUID()}`

    // ── Gas realism — subtract estimated buy+sell gas from realized PnL ─────
    // Note: on the (legacy) partial-exit path earlier sells' gas is not
    // accumulated; with the full-exit TP policy there is exactly one sell.
    const sellGasNative = gasNative(SELL_GAS_UNITS, await currentGasPriceWei())
    const buyGasNative = meta?.gasSpentNative ?? 0

    // Compute new realized PnL + remaining moonbag
    const priorExitNative = parseFloat(req.position.exitAmountNative ?? '0')
    const entryNative = parseFloat(req.position.entryAmountNative)
    const newExitNative = priorExitNative + effectiveNativeOut
    const newRealizedPnlNative = newExitNative - entryNative - buyGasNative - sellGasNative

    const remainingTokensWhole = totalTokensWhole - tokensToSellWhole
    const remainingTokensRaw = this.tokensToRawString(remainingTokensWhole, tokenDecimals)

    // Persist trade
    await insertPaperTrade({
      positionId: req.position.id,
      tokenAddress: req.position.tokenAddress,
      side: 'sell',
      quotedPriceNative: quote.executionPrice.toFixed(12),
      amountNative: effectiveNativeOut.toFixed(9),
      tokensAmount: this.tokensToRawString(tokensToSellWhole, tokenDecimals),
      slippageBps: 0,
      priceImpactPct: quote.priceImpactPct.toFixed(4),
      quoteSnapshot: {
        source: 'uniswap-v2-pair',
        fillSource: liveState ? 'live-requote' : 'cached-state',
        latencyMs: env.PAPER_LATENCY_MS,
        gasNative: sellGasNative,
        reason: req.reason,
        sellPctOfPosition: req.sellPctOfPosition,
        feeNative: quote.feeNative,
        spotPriceBefore: quote.spotPriceBefore,
        spotPriceAfter: quote.spotPriceAfter,
        newReserves: {
          ethReserve: quote.newState.ethReserve,
          tokenReserve: quote.newState.tokenReserve,
        },
      },
    })

    // Update position
    if (req.sellPctOfPosition >= 100) {
      const finalStatus = req.reason === 'stop-loss' ? 'stopped' : 'closed'
      await closePosition(req.position.id, {
        exitAmountNative: newExitNative.toFixed(9),
        realizedPnlNative: newRealizedPnlNative.toFixed(9),
        exitTxHash: txSignature,
        status: finalStatus,
      })
    } else {
      await markPartialExit(req.position.id, {
        exitAmountNative: newExitNative.toFixed(9),
        realizedPnlNative: newRealizedPnlNative.toFixed(9),
        moonbagTokens: remainingTokensRaw,
      })
    }

    const durationMs = Date.now() - startedAt

    log.info(
      {
        positionId: req.position.id,
        reason: req.reason,
        sellPct: req.sellPctOfPosition,
        tokensSold: tokensToSellWhole.toFixed(2),
        nativeReceived: effectiveNativeOut.toFixed(6),
        sellTaxPct: sellTaxPct.toFixed(2),
        gasNative: (buyGasNative + sellGasNative).toFixed(9),
        fillSource: liveState ? 'live-requote' : 'cached-state',
        pnlNative: newRealizedPnlNative.toFixed(6),
        priceImpactPct: quote.priceImpactPct.toFixed(3),
        durationMs,
      },
      'PAPER SELL filled',
    )

    // Telegram notification (fire-and-forget)
    {
      const tokenLabel = req.position.tokenSymbol ?? req.position.tokenAddress.slice(0, 10)
      const reasonEmoji: Record<string, string> = {
        'take-profit': '💰',
        'stop-loss': '🛑',
        manual: '👋',
        'stale-flat': '💤',
        'dev-sell': '🚨',
      }
      const emoji = reasonEmoji[req.reason] ?? '📤'
      const pnlSign = newRealizedPnlNative >= 0 ? '+' : ''
      void sendTelegramAlert(
        `${emoji} <b>SELL</b> — ${tokenLabel}\n\n` +
          `Reason: <b>${req.reason}</b>\n` +
          `Sold: <b>${req.sellPctOfPosition}%</b> of position\n` +
          `Received: <b>${effectiveNativeOut.toFixed(6)} ETH</b>${sellTaxPct > 0 ? ` (sell tax ${sellTaxPct.toFixed(1)}%)` : ''}\n` +
          `PnL: <b>${pnlSign}${newRealizedPnlNative.toFixed(6)} ETH</b>\n` +
          `Pos: <code>${req.position.id}</code>`,
      )
    }

    return {
      success: true,
      positionId: req.position.id,
      outputAmount: effectiveNativeOut.toFixed(9),
      executionPrice: quote.executionPrice,
      realizedSlippagePct: quote.priceImpactPct,
      txSignature,
      durationMs,
    }
  }

  private failSell(startedAt: number, reason: string): ExecutionResult {
    log.warn({ reason }, 'PAPER sell aborted')
    return {
      success: false,
      positionId: null,
      outputAmount: '0',
      executionPrice: 0,
      realizedSlippagePct: 0,
      txSignature: '',
      durationMs: Date.now() - startedAt,
      error: reason,
    }
  }

  /**
   * Simulated tx inclusion latency: wait PAPER_LATENCY_MS, then fetch the
   * pair's CURRENT on-chain reserves. Returns null when the state cannot be
   * read (caller falls back to the last known state).
   */
  private async refetchPairState(
    poolAddress: string | null | undefined,
    info: { token0?: string | undefined; token1?: string | undefined },
    tokenDecimals: number,
  ): Promise<PairState | null> {
    if (!poolAddress || !info.token0 || !info.token1) return null
    if (env.PAPER_LATENCY_MS > 0) {
      await new Promise((r) => setTimeout(r, env.PAPER_LATENCY_MS))
    }
    try {
      const pairContract = new Contract(poolAddress, UNISWAP_PAIR_ABI, rhProvider)
      const raw = await getRawPairReserves(pairContract)
      if (!raw) return null
      return normalizeReservesFromCache(
        raw,
        { token0: info.token0, token1: info.token1, tokenDecimals },
        WETH_ADDRESS,
      )
    } catch {
      return null
    }
  }

  /**
   * Extract PairState from a PoolCreatedEvent.
   * Converts raw reserve strings to human-readable PairState, determining
   * which side is WETH vs the memecoin.
   */
  private extractPairState(source: PoolCreatedEvent): PairState | null {
    const rawR0 = source.reserve0
    const rawR1 = source.reserve1
    if (!rawR0 || !rawR1) return null

    const wethLower = WETH_ADDRESS.toLowerCase()
    const token0 = source.token0
    const token1 = source.token1
    const tokenDecimals = source.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS

    let ethReserve: number
    let tokenReserve: number

    if (token0 && token0.toLowerCase() === wethLower) {
      ethReserve = parseFloat(rawR0) / 1e18
      tokenReserve = parseFloat(rawR1) / 10 ** tokenDecimals
    } else if (token1 && token1.toLowerCase() === wethLower) {
      ethReserve = parseFloat(rawR1) / 1e18
      tokenReserve = parseFloat(rawR0) / 10 ** tokenDecimals
    } else {
      return null
    }

    if (ethReserve <= 0 || tokenReserve <= 0) return null

    return { ethReserve, tokenReserve, tokenDecimals }
  }

  private tokensToRawString(tokens: number, decimals: number): string {
    const raw = Math.floor(tokens * 10 ** decimals)
    return raw.toString()
  }

  private fail(startedAt: number, reason: string): ExecutionResult {
    log.warn({ reason }, 'PAPER buy aborted')
    return {
      success: false,
      positionId: null,
      outputAmount: '0',
      executionPrice: 0,
      realizedSlippagePct: 0,
      txSignature: '',
      durationMs: Date.now() - startedAt,
      error: reason,
    }
  }
}

export const paperExecutor = new PaperExecutor()
