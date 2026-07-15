import { randomUUID } from 'node:crypto'
import { Contract, MaxUint256, type TransactionReceipt, type TransactionResponse, type Wallet } from 'ethers'
import { createChildLogger } from '../utils/logger.js'
import { env } from '../config/env.js'
import { rhProvider, WETH_ADDRESS } from '../utils/robbinhood.utils.js'
import { sendTelegramAlert } from '../utils/telegram.js'
import { getBotWallet } from '../utils/wallet.js'
import { eventBus } from '../events/event-bus.js'
import { extractTxFill, realizedEthOutWei } from './tx-fill.js'
import {
  insertPosition,
  findOpenPositionByToken,
  markPartialExit,
  closePosition,
} from '../positions/position.repository.js'
import type { BaseExecutor, ExecutionResult } from './base.executor.js'
import type { TradeSignal, PoolCreatedEvent } from '../events/event-types.js'
import type { Position } from '../database/schema.js'
import { quoteBuy, type PairState } from './uniswap-math.js'

const log = createChildLogger('real-executor')

// ── Contract ABIs ────────────────────────────────────────────────────────────

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]

const UNISWAP_V2_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] amounts)',
]

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum ETH to leave in wallet (never spend entire balance). */
const MIN_ETH_RESERVE = 0.005 // 0.005 ETH for gas
/** Timeout for tx confirmation (ms). */
const CONFIRM_TIMEOUT_MS = 60_000
/** Default deadline for swap transactions (seconds from now). */
const DEFAULT_DEADLINE_SECONDS = 60
/** Gas limit for simple ERC-20 approve calls. */
const APPROVE_GAS_LIMIT = 60_000n

// ── Sell config ──────────────────────────────────────────────────────────────

const MAX_SELL_RETRIES = 3
const SELL_RETRY_BACKOFF_MS = [500, 1_000, 2_000]
/** Escalating priority fees per retry (gwei). Index 0 = first send. */
const SELL_PRIORITY_FEES_GWEI = [2n, 5n, 10n]
/** Slippage tolerance for Uniswap sells (percent). */
const UNISWAP_SELL_SLIPPAGE_PCT = 3

export type SellReason =
  | 'take-profit'
  | 'stop-loss'
  | 'manual'
  | 'shutdown'
  | 'stale-flat'

export interface RealSellRequest {
  position: Position
  sellPctOfPosition: number
  reason: SellReason
  /** Current Uniswap V2 pair reserves. */
  currentState: PairState
}

/**
 * Test whether an error during send/confirm is retryable.
 * EVM equivalents of transient errors: network issues, nonce conflicts,
 * replacement underpriced (can resubmit higher).
 */
function isRetryableTxError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (msg.includes('timeout')) return true
    if (msg.includes('timed out')) return true
    if (msg.includes('econnrefused')) return true
    if (msg.includes('econnreset')) return true
    if (msg.includes('etimedout')) return true
    if (msg.includes('enotfound')) return true
    if (msg.includes('network')) return true
    if (msg.includes('nonce')) return true
    if (msg.includes('underpriced')) return true
    if (msg.includes('replacement')) return true
    if (msg.includes('already known')) return true // duplicate = safe
    // TypeError = fetch/network failure
    if (err instanceof TypeError) return true
  }
  return false
}

/**
 * Wait for a transaction to be confirmed (1 block), with a timeout.
 * Returns the receipt or throws on timeout/reversion.
 */
async function waitForConfirmation(
  tx: TransactionResponse,
  label: string,
): Promise<TransactionReceipt> {
  const receipt = await Promise.race([
    tx.wait(1),
    new Promise<null>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label}: confirmation timed out after ${CONFIRM_TIMEOUT_MS}ms`)),
        CONFIRM_TIMEOUT_MS,
      ),
    ),
  ])

  if (!receipt || receipt.status === null) {
    throw new Error(`${label}: no receipt returned`)
  }
  if (receipt.status === 0) {
    throw new Error(`${label}: transaction reverted (status=0)`)
  }

  return receipt
}

/**
 * Fetch token decimals from an ERC-20 contract. Falls back to 18 on failure.
 */
async function fetchTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const contract = new Contract(tokenAddress, ERC20_ABI, rhProvider)
    return Number(await contract.decimals!())
  } catch {
    log.warn({ token: tokenAddress }, 'Could not fetch token decimals, defaulting to 18')
    return 18
  }
}

export class RealExecutor implements BaseExecutor {
  readonly mode = 'real' as const

  async execute(signal: TradeSignal): Promise<ExecutionResult> {
    const startedAt = Date.now()
    const lockKey = `buy_lock:${signal.tokenAddress}`

    if (signal.action !== 'buy') {
      return this.fail(startedAt, 'real executor MVP supports buy only via this path')
    }

    // ── Redis atomic lock ──────────────────────────────────────────────────
    const acquired = await eventBus.client.set(
      lockKey, signal.signalId, 'EX', 60, 'NX',
    )
    if (!acquired) {
      return this.fail(startedAt, `duplicate buy prevented: lock held for ${signal.tokenAddress}`)
    }

    let txHash: string | undefined
    try {
      // Idempotency — refuse double-buy on the same token
      const existing = await findOpenPositionByToken('real', signal.tokenAddress)
      if (existing) {
        return this.fail(startedAt, `position already open for ${signal.tokenAddress}`)
      }

      const wallet = getBotWallet()
      if (!wallet) {
        return this.fail(startedAt, 'no wallet configured for real mode')
      }

      // ── Wallet balance check ──────────────────────────────────────────────
      const balanceWei = await rhProvider.getBalance(wallet.address)
      const balanceEth = Number(balanceWei) / 1e18
      const costEth = signal.amountNative
      const minBalanceEth = env.MIN_WALLET_BALANCE_NATIVE + MIN_ETH_RESERVE

      if (balanceEth < minBalanceEth + costEth) {
        return this.fail(
          startedAt,
          `insufficient wallet balance: have ${balanceEth.toFixed(4)} ETH, ` +
            `need ${(minBalanceEth + costEth).toFixed(4)} ETH ` +
            `(floor ${env.MIN_WALLET_BALANCE_NATIVE} + trade ${costEth} + reserve)`,
        )
      }

      // 1. Extract pair state from source event
      const source = signal.opportunity.sourceEvent as PoolCreatedEvent
      const pairState = this.extractPairState(source)
      if (!pairState) {
        return this.fail(
          startedAt,
          `missing pair reserves on source event for ${signal.tokenAddress}`,
        )
      }

      // 2. Quote expected tokens out via Uniswap V2 math
      let quote: ReturnType<typeof quoteBuy>
      try {
        quote = quoteBuy(pairState, signal.amountNative)
      } catch (err) {
        return this.fail(startedAt, `quoteBuy failed: ${(err as Error).message}`)
      }

      if (quote.tokensOut <= 0) {
        return this.fail(startedAt, `quoteBuy returned zero tokensOut`)
      }

      // 3. Build + send Uniswap V2 buy tx via Router02
      const router = new Contract(env.UNISWAP_ROUTER_ADDRESS, UNISWAP_V2_ROUTER_ABI, wallet)
      const tokenDecimals = await fetchTokenDecimals(signal.tokenAddress)

      // Compute minTokensOut with slippage
      const slippagePct = signal.slippageBps / 100
      const minTokensOutWhole = quote.tokensOut * (1 - slippagePct / 100)
      const minTokensOutRaw = BigInt(Math.floor(minTokensOutWhole * 10 ** tokenDecimals))

      const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS
      const path = [WETH_ADDRESS, signal.tokenAddress]

      // Wallet's token balance BEFORE the swap — fallback input for the fill
      // extraction below (tokens with non-standard Transfer events).
      const tokenReader = new Contract(signal.tokenAddress, ERC20_ABI, rhProvider)
      let preTokenBalanceRaw = 0n
      try {
        preTokenBalanceRaw = await tokenReader.balanceOf!(wallet.address)
      } catch {
        // assume 0 — the dedicated wallet doesn't hold the token before buying it
      }

      // Build tx overrides
      const txOverrides: Record<string, unknown> = {
        value: BigInt(Math.floor(signal.amountNative * 1e18)),
        gasLimit: signal.gasLimit ?? 400_000n,
      }
      if (signal.maxFeePerGas != null) txOverrides.maxFeePerGas = BigInt(signal.maxFeePerGas)
      if (signal.maxPriorityFeePerGas != null) txOverrides.maxPriorityFeePerGas = BigInt(signal.maxPriorityFeePerGas)

      let swapTx: TransactionResponse
      try {
        swapTx = await router.swapExactETHForTokens!(
          minTokensOutRaw,
          path,
          wallet.address,
          deadline,
          txOverrides,
        )
      } catch (err) {
        return this.fail(startedAt, `Uniswap swapExactETHForTokens failed: ${(err as Error).message}`)
      }

      txHash = swapTx.hash

      // 4. Confirm
      let receipt: TransactionReceipt
      try {
        receipt = await waitForConfirmation(swapTx, `buy:${signal.tokenAddress.slice(0, 10)}`)
      } catch (err) {
        return this.fail(startedAt, `Confirmation failed: ${(err as Error).message}`)
      }

      // 5. Actual fill from the confirmed receipt. NEVER record more tokens
      // than the wallet received: a later 100% sell of an overstated amount
      // reverts transferFrom on every attempt and strands the position.
      const fill = extractTxFill(receipt, wallet.address, signal.tokenAddress, WETH_ADDRESS)
      const buyGasNative = Number(receipt.gasUsed * receipt.gasPrice) / 1e18

      let actualTokensRaw: bigint
      if (fill?.tokenDeltaRaw != null && fill.tokenDeltaRaw > 0n) {
        actualTokensRaw = fill.tokenDeltaRaw
      } else {
        // Fallback 1: wallet balance delta (token emitted no standard Transfer)
        let balanceDelta = 0n
        try {
          const postTokenBalanceRaw: bigint = await tokenReader.balanceOf!(wallet.address)
          balanceDelta = postTokenBalanceRaw - preTokenBalanceRaw
        } catch {
          // fall through to the taxed quote
        }
        if (balanceDelta > 0n) {
          actualTokensRaw = balanceDelta
        } else {
          // Fallback 2: quote minus the measured buy tax — conservative estimate
          const quoteTokensRaw = BigInt(Math.floor(quote.tokensOut * 10 ** tokenDecimals))
          const buyTaxBps = BigInt(Math.round((signal.honeypotProbe?.buyTaxPct ?? 0) * 100))
          actualTokensRaw = quoteTokensRaw - (quoteTokensRaw * buyTaxBps) / 10_000n
          log.warn(
            { txHash, tokenAddress: signal.tokenAddress },
            'Buy fill not found in logs or balance delta — recording taxed quote estimate',
          )
        }
      }

      // Compute effective execution price
      const actualTokensWhole = Number(actualTokensRaw) / 10 ** tokenDecimals
      const executionPrice =
        actualTokensWhole > 0
          ? signal.amountNative / actualTokensWhole
          : quote.executionPrice
      const priceImpactPct = quote.priceImpactPct

      // 6. Persist position
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
        mode: 'real',
        status: 'open',
        entryPriceNative: executionPrice.toFixed(12),
        entryAmountNative: signal.amountNative.toFixed(9),
        entryTxHash: txHash,
        tokensReceived: actualTokensRaw.toString(),
        takeProfitPct: env.TAKE_PROFIT_PCT.toFixed(4),
        sellPctAtTp: env.SELL_PCT_AT_TP.toFixed(4),
        stopLossPct: env.STOP_LOSS_PCT.toFixed(4),
        strategyName: signal.strategy,
        signalId: signal.signalId,
        riskScore: signal.opportunity.risk.riskScore,
        riskLevel: signal.opportunity.risk.riskLevel,
        riskFlags: signal.opportunity.risk.flags,
        metadata: {
          route: 'uniswap',
          priceImpactPct,
          // Buy-side gas — read back at exit time so realized PnL reflects the
          // real wallet cost, matching the paper executor's accounting.
          gasSpentNative: buyGasNative,
          pairReservesSnapshot: {
            ethReserve: pairState.ethReserve,
            tokenReserve: pairState.tokenReserve,
          },
          tokenDecimals: pairState.tokenDecimals,
          // Immutable pair info — cached to avoid RPC calls for token0/token1
          // on every block during position monitoring.
          token0: source.token0,
          token1: source.token1,
          isToken0Eth: (source.token0 ?? '').toLowerCase() === WETH_ADDRESS.toLowerCase(),
          totalSupply: source.totalSupply,
          deployerAddress: signal.opportunity.deployerAddress,
          // Honeypot probe taxes — persisted for audit (real fills already
          // reflect any on-chain tax, so no adjustment is applied here).
          ...(signal.honeypotProbe && { honeypotProbe: signal.honeypotProbe }),
        },
      })

      // Pre-approve the router in the background so the FIRST sell is a single
      // transaction. Without this, every exit pays approve+confirm latency at
      // the worst possible moment (a dump firing the stop-loss).
      void this.preApproveRouter(signal.tokenAddress, wallet)

      const durationMs = Date.now() - startedAt
      log.info(
        {
          positionId: position.id,
          symbol: source.tokenMetadata?.symbol ?? '?',
          tokenAddress: signal.tokenAddress,
          amountNative: signal.amountNative,
          tokensReceived: actualTokensWhole,
          executionPrice: executionPrice.toExponential(4),
          priceImpactPct: priceImpactPct.toFixed(3),
          gasNative: buyGasNative.toFixed(9),
          fillSource: fill?.tokenDeltaRaw != null && fill.tokenDeltaRaw > 0n ? 'tx-logs' : 'fallback',
          route: 'uniswap',
          txHash,
          durationMs,
        },
        'REAL BUY_EXECUTED',
      )

      // Telegram notification (fire-and-forget)
      {
        const tokenLabel = source.tokenMetadata?.symbol ?? signal.tokenAddress.slice(0, 10)
        const totalSupplyNum = source.totalSupply ? Number(source.totalSupply) / 10 ** tokenDecimals : 1_000_000_000
        const mcUsdApprox = (executionPrice * totalSupplyNum).toFixed(2)
        void sendTelegramAlert(
          `🟢 <b>BUY</b> — ${tokenLabel}\n\n` +
            `Spent: <b>${signal.amountNative.toFixed(4)} ETH</b>\n` +
            `Got: <b>${actualTokensWhole.toFixed(2)} tokens</b>\n` +
            `Price: <b>${executionPrice.toExponential(4)} ETH</b>\n` +
            `MC: ~$${mcUsdApprox}\n` +
            `Tx: <code>${txHash.slice(0, 10)}...</code>\n` +
            `Pos: <code>${position.id}</code>`,
        )
      }

      return {
        success: true,
        positionId: position.id,
        outputAmount: actualTokensWhole.toFixed(6),
        executionPrice,
        realizedSlippagePct: priceImpactPct,
        txSignature: txHash,
        durationMs,
      }
    } catch (err) {
      log.error(
        { err, tokenAddress: signal.tokenAddress, txHash },
        'Unexpected error during buy execution',
      )
      return this.fail(startedAt, `unexpected error: ${(err as Error).message}`)
    } finally {
      await eventBus.client.del(lockKey).catch(() => {})
    }
  }

  // ── Sell ──────────────────────────────────────────────────────────────────

  async sell(req: RealSellRequest): Promise<ExecutionResult> {
    const startedAt = Date.now()

    if (req.position.status === 'closed' || req.position.status === 'stopped') {
      return this.failSell(startedAt, `position already closed (${req.position.status})`)
    }

    const totalTokensRaw = req.position.isMoonbag
      ? BigInt(req.position.moonbagTokens ?? '0')
      : BigInt(req.position.tokensReceived ?? '0')

    if (totalTokensRaw === 0n) {
      return this.failSell(startedAt, 'no tokens to sell')
    }

    const wallet = getBotWallet()
    if (!wallet) {
      return this.failSell(startedAt, 'no wallet configured')
    }

    let tokensToSellRaw = (totalTokensRaw * BigInt(Math.round(req.sellPctOfPosition))) / 100n

    // Clamp to the wallet's REAL balance. Recorded fills can overstate what the
    // wallet holds (fee-on-transfer, legacy quote-based records) — selling more
    // than the balance reverts transferFrom on every retry, stranding the
    // position while burning gas.
    try {
      const tokenReader = new Contract(req.position.tokenAddress, ERC20_ABI, rhProvider)
      const walletBalanceRaw: bigint = await tokenReader.balanceOf!(wallet.address)
      if (walletBalanceRaw === 0n) {
        return this.failSell(
          startedAt,
          'wallet holds zero tokens for this position — manual reconciliation required',
        )
      }
      if (req.sellPctOfPosition >= 100) {
        // Full exit: sell the real balance so no dust is left behind
        tokensToSellRaw = walletBalanceRaw
      } else if (tokensToSellRaw > walletBalanceRaw) {
        log.warn(
          {
            positionId: req.position.id,
            recorded: tokensToSellRaw.toString(),
            balance: walletBalanceRaw.toString(),
          },
          'Recorded tokens exceed wallet balance — clamping sell to balance',
        )
        tokensToSellRaw = walletBalanceRaw
      }
    } catch (err) {
      log.warn(
        { err, positionId: req.position.id },
        'balanceOf check failed — proceeding with recorded amount',
      )
    }
    if (tokensToSellRaw === 0n) {
      return this.failSell(startedAt, `sellPctOfPosition too small — 0 tokens to sell`)
    }

    // ── Sell via Uniswap V2 (direct pair or Router) ───────────────────────
    let outcome: {
      txSig: string
      nativeOut: number
      nativeOutWei: bigint
      priceImpactPct: number
      gasNative: number
    }
    try {
      outcome = await this.sellViaUniswap(req, tokensToSellRaw)
    } catch (err) {
      return this.failSell(startedAt, (err as Error).message)
    }

    // ── Update DB ─────────────────────────────────────────────────────────
    // Gas accounting mirrors the paper executor: entry gas (stamped in metadata
    // at buy time) + this sell's gas come out of realized PnL. On the (legacy)
    // partial-exit path earlier sells' gas is not accumulated; with the
    // full-exit TP policy there is exactly one sell.
    const meta = req.position.metadata as
      | { gasSpentNative?: number; tokenDecimals?: number }
      | null
    const buyGasNative = meta?.gasSpentNative ?? 0
    const entryNative = parseFloat(req.position.entryAmountNative)
    const priorExit = parseFloat(req.position.exitAmountNative ?? '0')
    const newExitNative = priorExit + outcome.nativeOut
    const newPnlNative = newExitNative - entryNative - buyGasNative - outcome.gasNative
    const remainingRaw = req.sellPctOfPosition >= 100
      ? '0'
      : (totalTokensRaw - tokensToSellRaw).toString()

    if (req.sellPctOfPosition >= 100) {
      const finalStatus = req.reason === 'stop-loss' ? 'stopped' : 'closed'
      await closePosition(req.position.id, {
        exitAmountNative: newExitNative.toFixed(9),
        realizedPnlNative: newPnlNative.toFixed(9),
        exitTxHash: outcome.txSig,
        status: finalStatus,
      })
    } else {
      await markPartialExit(req.position.id, {
        exitAmountNative: newExitNative.toFixed(9),
        realizedPnlNative: newPnlNative.toFixed(9),
        moonbagTokens: remainingRaw,
      })
    }

    const durationMs = Date.now() - startedAt
    log.info(
      {
        positionId: req.position.id,
        reason: req.reason,
        sellPct: req.sellPctOfPosition,
        nativeReceived: outcome.nativeOut.toFixed(6),
        gasNative: (buyGasNative + outcome.gasNative).toFixed(9),
        pnlNative: newPnlNative.toFixed(6),
        txHash: outcome.txSig,
        durationMs,
      },
      'REAL SELL filled',
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
      const pnlSign = newPnlNative >= 0 ? '+' : ''
      void sendTelegramAlert(
        `${emoji} <b>SELL</b> — ${tokenLabel}\n\n` +
          `Reason: <b>${req.reason}</b>\n` +
          `Sold: <b>${req.sellPctOfPosition}%</b> of position\n` +
          `Received: <b>${outcome.nativeOut.toFixed(6)} ETH</b>\n` +
          `PnL: <b>${pnlSign}${newPnlNative.toFixed(6)} ETH</b>\n` +
          `Tx: <code>${outcome.txSig.slice(0, 10)}...</code>\n` +
          `Pos: <code>${req.position.id}</code>`,
      )
    }

    return {
      success: true,
      positionId: req.position.id,
      outputAmount: outcome.nativeOut.toFixed(9),
      executionPrice:
        outcome.nativeOut / (Number(tokensToSellRaw) / 10 ** (meta?.tokenDecimals ?? 18)),
      realizedSlippagePct: outcome.priceImpactPct,
      txSignature: outcome.txSig,
      durationMs,
    }
  }

  // ── Sell via Uniswap V2 Router ───────────────────────────────────────────

  private async sellViaUniswap(
    req: RealSellRequest,
    tokensToSellRaw: bigint,
  ): Promise<{
    txSig: string
    nativeOut: number
    nativeOutWei: bigint
    priceImpactPct: number
    gasNative: number
  }> {
    const wallet = getBotWallet()
    if (!wallet) throw new Error('no wallet configured')

    const tokenLabel = req.position.tokenAddress.slice(0, 10)
    const router = new Contract(env.UNISWAP_ROUTER_ADDRESS, UNISWAP_V2_ROUTER_ABI, wallet)
    const token = new Contract(req.position.tokenAddress, ERC20_ABI, wallet)

    // 1. Approve Uniswap router to spend tokens (normally a no-op — the buy
    // path pre-approves MaxUint256 right after entry)
    let approveGasFeeWei = 0n
    const allowance: bigint = await token.allowance!(wallet.address, env.UNISWAP_ROUTER_ADDRESS)
    if (allowance < tokensToSellRaw) {
      log.info({ token: tokenLabel, allowance: allowance.toString(), needed: tokensToSellRaw.toString() },
        'Approving Uniswap router for sell')
      const approveTx: TransactionResponse = await token.approve!(
        env.UNISWAP_ROUTER_ADDRESS,
        tokensToSellRaw,
        { gasLimit: APPROVE_GAS_LIMIT },
      )
      const approveReceipt = await waitForConfirmation(approveTx, `approve:${tokenLabel}`)
      approveGasFeeWei = approveReceipt.gasUsed * approveReceipt.gasPrice
    }

    // 2. Quote expected ETH out
    const path = [req.position.tokenAddress, WETH_ADDRESS]

    let lastError: Error | undefined

    for (let attempt = 0; attempt < MAX_SELL_RETRIES; attempt++) {
      try {
        const priorityFeeGwei = SELL_PRIORITY_FEES_GWEI[attempt] ?? SELL_PRIORITY_FEES_GWEI.at(-1)!

        // Fresh deadline per attempt — backoff + confirmation timeouts can
        // outlive a deadline computed once before the loop, auto-reverting
        // every retry.
        const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS

        // Get quote from router
        const amountsOut: bigint[] = await router.getAmountsOut!(tokensToSellRaw, path)
        const expectedEthOutWei = amountsOut[amountsOut.length - 1]!
        // Apply slippage tolerance
        const minEthOutWei = (expectedEthOutWei * BigInt(100 - UNISWAP_SELL_SLIPPAGE_PCT)) / 100n

        // Build tx overrides with escalating priority fees
        const txOverrides: Record<string, unknown> = {
          maxPriorityFeePerGas: priorityFeeGwei * 1_000_000_000n,
          gasLimit: 300_000n, // generous limit for swapExactTokensForETHSupportingFeeOnTransferTokens
        }

        const swapTx: TransactionResponse = await router.swapExactTokensForETHSupportingFeeOnTransferTokens!(
          tokensToSellRaw,
          minEthOutWei,
          path,
          wallet.address,
          deadline,
          txOverrides,
        )

        const receipt = await waitForConfirmation(swapTx, `sell:uniswap:${tokenLabel}:a${attempt}`)

        // Actual ETH received = the WETH the router unwrapped in this tx.
        // Falls back to the pre-trade quote only if the log is missing.
        const fill = extractTxFill(receipt, wallet.address, req.position.tokenAddress, WETH_ADDRESS)
        const nativeOutWei = realizedEthOutWei(fill, expectedEthOutWei)
        const gasNative = Number(approveGasFeeWei + receipt.gasUsed * receipt.gasPrice) / 1e18

        const priceImpactPct =
          expectedEthOutWei > 0n
            ? Number(((expectedEthOutWei - nativeOutWei) * 10000n) / expectedEthOutWei) / 100
            : 0

        if (attempt > 0) {
          log.info({ token: tokenLabel, attempt, txHash: swapTx.hash },
            'Uniswap sell succeeded on retry')
        }

        return {
          txSig: swapTx.hash,
          nativeOut: Number(nativeOutWei) / 1e18,
          nativeOutWei,
          priceImpactPct: Math.max(0, priceImpactPct),
          gasNative,
        }
      } catch (err) {
        lastError = err as Error
        if (!isRetryableTxError(err)) throw err
        if (attempt < MAX_SELL_RETRIES - 1) {
          const delay = SELL_RETRY_BACKOFF_MS[attempt] ?? 2_000
          log.warn(
            { token: tokenLabel, attempt, delayMs: delay, err: lastError.message },
            'Uniswap sell failed — retrying with higher fee',
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError ?? new Error(`Uniswap sell failed after ${MAX_SELL_RETRIES} attempts`)
  }

  /**
   * Background unlimited approve fired right after a buy confirms, so the
   * first sell is a single transaction instead of approve+swap. Failures are
   * non-fatal — the sell path still approves on demand.
   */
  private async preApproveRouter(tokenAddress: string, wallet: Wallet): Promise<void> {
    const tokenLabel = tokenAddress.slice(0, 10)
    try {
      const token = new Contract(tokenAddress, ERC20_ABI, wallet)
      const allowance: bigint = await token.allowance!(wallet.address, env.UNISWAP_ROUTER_ADDRESS)
      if (allowance >= MaxUint256 / 2n) return

      const approveTx: TransactionResponse = await token.approve!(
        env.UNISWAP_ROUTER_ADDRESS,
        MaxUint256,
        { gasLimit: APPROVE_GAS_LIMIT },
      )
      const receipt = await waitForConfirmation(approveTx, `pre-approve:${tokenLabel}`)
      log.info(
        { token: tokenLabel, gasNative: (Number(receipt.gasUsed * receipt.gasPrice) / 1e18).toFixed(9) },
        'Router pre-approved — exits are now single-tx',
      )
    } catch (err) {
      log.warn(
        { err, token: tokenLabel },
        'Pre-approve failed — sell path will approve on demand',
      )
    }
  }

  /** Extract PairState from PoolCreatedEvent — mirrors paper executor logic. */
  private extractPairState(source: PoolCreatedEvent): PairState | null {
    const rawR0 = source.reserve0
    const rawR1 = source.reserve1
    if (!rawR0 || !rawR1) return null

    const wethLower = WETH_ADDRESS.toLowerCase()
    const token0 = source.token0
    const token1 = source.token1
    const tokenDecimals = source.tokenDecimals ?? 18

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

  private fail(startedAt: number, reason: string): ExecutionResult {
    log.warn({ reason }, 'REAL buy aborted')
    return { success: false, positionId: null, outputAmount: '0', executionPrice: 0, realizedSlippagePct: 0, txSignature: '', durationMs: Date.now() - startedAt, error: reason }
  }

  private failSell(startedAt: number, reason: string): ExecutionResult {
    log.warn({ reason }, 'REAL sell aborted')
    return { success: false, positionId: null, outputAmount: '0', executionPrice: 0, realizedSlippagePct: 0, txSignature: '', durationMs: Date.now() - startedAt, error: reason }
  }
}

export const realExecutor = new RealExecutor()
