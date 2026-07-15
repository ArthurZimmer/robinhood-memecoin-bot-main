import { Contract } from 'ethers'
import { createChildLogger } from '../utils/logger.js'
import { env } from '../config/env.js'
import { rhProvider, WETH_ADDRESS } from '../utils/robbinhood.utils.js'
import { wsManager } from '../utils/ws-manager.js'
import { listActivePositions, closePosition } from './position.repository.js'
import { probeToken } from '../risk/honeypot-probe.js'
import { sendTelegramAlert } from '../utils/telegram.js'
import { paperExecutor } from '../executor/paper.executor.js'
import { realExecutor } from '../executor/real.executor.js'
import {
  getRawPairReserves,
  getRawPairInfo,
  normalizeReserves,
  normalizeReservesFromCache,
  type PairState,
  type CachedPairInfo,
} from '../executor/uniswap-math.js'
import { DevWalletMonitor, type DevDumpCallback } from '../monitor/dev-wallet.monitor.js'
import type { Position } from '../database/schema.js'

const log = createChildLogger('position-manager')

// Minimal Uniswap V2 Pair ABI — used to create Contract instances for state queries.
const UNISWAP_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]

// Sync fires on EVERY swap/mint/burn and carries the NEW reserves in the payload —
// TP/SL can be evaluated straight off the push with zero eth_call.
const UNISWAP_PAIR_SYNC_ABI = [
  'event Sync(uint112 reserve0, uint112 reserve1)',
]

// Delegates to the active executor (real or paper) — both share identical sell signatures.
async function executorSell(req: Parameters<typeof paperExecutor.sell>[0]) {
  if (env.TRADING_MODE === 'real') {
    // RealSellRequest is structurally compatible with PaperSellRequest
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return realExecutor.sell(req as any)
  }
  return paperExecutor.sell(req)
}

// ── Position Manager ─────────────────────────────────────────────────────────
// Push-first design (QuickNode counts every WS notification as a request, and
// Robinhood Chain runs at ~10 blocks/s — a newHeads subscription alone would
// cost ~800K requests/day):
//
//   • Per-position `Sync` log subscription — the pair pushes its new reserves on
//     every trade. TP/SL evaluated on the push itself: faster than the old
//     per-block eth_call (no extra round-trip) and costs requests only when the
//     watched pair actually trades.
//   • DB sync every syncIntervalMs (5s) — Postgres only, zero RPC. Discovers
//     new/closed positions and manages subscriptions.
//   • RPC fallback sweep every rpcCheckIntervalMs — one getReserves per open
//     position. Covers dead pairs (LP pulled → no more Sync events), stale-flat
//     detection, and TP/SL backup while the WS is reconnecting.

interface PositionManagerOptions {
  /** DB sync interval — discovers new positions and manages subscriptions. Default 5s. */
  syncIntervalMs?: number
  /**
   * RPC fallback sweep interval. Default 30s with WS (Sync pushes are the primary
   * signal), 5s without WS (polling is the only signal).
   */
  rpcCheckIntervalMs?: number
  /**
   * After this many ms, a position with zero volume change (ethReserve identical to
   * entry snapshot) is force-closed to free up cap.
   */
  staleKillAgeMs?: number
  /** Tolerance for "no volume" detection in native ETH. */
  staleEthReserveToleranceNative?: number
}

export interface LivePositionSnapshot {
  positionId: string
  tokenAddress: string
  entryPriceNative: number
  spotPriceNative: number
  pnlPct: number
  fetchedAt: number
}

export class PositionManager {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly syncIntervalMs: number
  private readonly rpcCheckIntervalMs: number
  private readonly staleKillAgeMs: number
  private readonly staleEthReserveToleranceNative: number
  private readonly inflight = new Set<string>()
  private lastRpcCheckAt = 0

  // Latest PnL snapshot per position — read by dashboard server
  private readonly snapshots = new Map<string, LivePositionSnapshot>()
  // Position objects cache — avoids DB lookup in callbacks
  private readonly positionCache = new Map<string, Position>()
  // Immutable pair info per position — lets Sync pushes be normalized with zero RPC
  private readonly pairInfoCache = new Map<string, { info: CachedPairInfo; isToken0Eth: boolean }>()
  // Dev wallet rug-pull monitor — watches deployer's token balance for dumps
  private readonly devWalletMonitor: DevWalletMonitor

  constructor(options: PositionManagerOptions = {}) {
    this.syncIntervalMs = options.syncIntervalMs ?? 5_000
    this.rpcCheckIntervalMs = options.rpcCheckIntervalMs
      ?? (wsManager.enabled ? 30_000 : 5_000)
    this.staleKillAgeMs = options.staleKillAgeMs ?? 90_000
    this.staleEthReserveToleranceNative = options.staleEthReserveToleranceNative ?? 0.005

    // Dev wallet monitor callback — bridges the monitor back into the sell path
    const onDevDump: DevDumpCallback = (positionId, _devAddress, _soldPct) => {
      void this.handleDevDump(positionId)
    }
    this.devWalletMonitor = new DevWalletMonitor(onDevDump)
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn('start() called but already running')
      return
    }
    this.running = true

    this.scheduleNextSync(0)
    log.info(
      {
        syncIntervalMs: this.syncIntervalMs,
        rpcCheckIntervalMs: this.rpcCheckIntervalMs,
        staleKillAgeMs: this.staleKillAgeMs,
        pushMode: wsManager.enabled,
      },
      'PositionManager started (per-pair Sync subscriptions + RPC fallback sweep)',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Unsubscribe all pair Sync listeners
    for (const positionId of this.positionCache.keys()) {
      wsManager.unregister(this.syncKey(positionId))
    }
    // Stop dev wallet monitoring for all positions
    await this.devWalletMonitor.stop()
    log.info('PositionManager stopped')
  }

  /** Dashboard read API — returns latest cached PnL snapshots for all tracked positions. */
  getSnapshots(): LivePositionSnapshot[] {
    return Array.from(this.snapshots.values())
  }

  getSnapshot(positionId: string): LivePositionSnapshot | undefined {
    return this.snapshots.get(positionId)
  }

  // ── Slow sync loop — DB sync + subscription management + RPC fallback ────────

  private scheduleNextSync(delayMs: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      void this.syncTick().finally(() => {
        if (this.running) this.scheduleNextSync(this.syncIntervalMs)
      })
    }, delayMs)
  }

  private async syncTick(): Promise<void> {
    let positions: Position[]
    try {
      positions = await listActivePositions(env.TRADING_MODE)
    } catch (err) {
      log.error({ err }, 'Failed to list active positions — skipping sync')
      return
    }

    const activeIds = new Set(positions.map((p) => p.id))

    // Unsubscribe positions that closed since last sync
    for (const positionId of this.positionCache.keys()) {
      if (!activeIds.has(positionId)) {
        this.untrack(positionId)
      }
    }

    // Cache new positions + subscribe Sync + start dev wallet monitoring
    for (const position of positions) {
      const isNew = !this.positionCache.has(position.id)
      this.positionCache.set(position.id, position)

      if (isNew) {
        this.subscribeSync(position)
        void this.devWalletMonitor.watch(position)
        log.debug(
          { positionId: position.id, tokenAddress: position.tokenAddress.slice(0, 10) },
          'Tracking new position',
        )
      }
    }

    // RPC fallback sweep — throttled to rpcCheckIntervalMs. Sync pushes handle
    // real-time TP/SL; this sweep covers dead pairs, stale-flat, and WS outages.
    const now = Date.now()
    if (positions.length > 0 && now - this.lastRpcCheckAt >= this.rpcCheckIntervalMs) {
      this.lastRpcCheckAt = now
      const toCheck = positions.filter((p) => !this.inflight.has(p.id))
      await Promise.allSettled(toCheck.map((p) => this.checkPosition(p)))
    }
  }

  // ── Fast path — pair Sync push (WebSocket) ──────────────────────────────────

  private syncKey(positionId: string): string {
    return `position-sync:${positionId}`
  }

  /**
   * Subscribe to the pair's Sync event. The push carries the fresh reserves, so
   * TP/SL is evaluated with ZERO extra RPC and no polling delay — the sell fires
   * in the same tick the price-moving trade lands.
   */
  private subscribeSync(position: Position): void {
    if (!wsManager.enabled) return

    wsManager.register(this.syncKey(position.id), (provider) => {
      const pairContract = new Contract(position.poolAddress, UNISWAP_PAIR_SYNC_ABI, provider)

      const handler = (reserve0: bigint, reserve1: bigint) => {
        void this.onSyncPush(position.id, reserve0, reserve1).catch((err) => {
          log.error({ err, positionId: position.id }, 'Sync push evaluation failed')
        })
      }

      // .catch: a rejected subscribe must not become a fatal unhandledRejection
      pairContract.on('Sync', handler).catch((err) => {
        log.warn({ err, positionId: position.id }, 'Sync subscribe failed — wsManager will retry on reconnect')
      })
      log.debug(
        { positionId: position.id, pair: position.poolAddress.slice(0, 12) },
        'Subscribed to pair Sync events',
      )

      return () => {
        pairContract.off('Sync', handler).catch(() => { /* socket already dead */ })
      }
    })
  }

  private async onSyncPush(positionId: string, reserve0: bigint, reserve1: bigint): Promise<void> {
    // Always read the latest position object — status may have changed (moonbag etc.)
    const position = this.positionCache.get(positionId)
    if (!position || this.inflight.has(positionId)) return

    // LP fully pulled — no price to evaluate; the RPC fallback sweep force-closes
    if (reserve0 === 0n || reserve1 === 0n) return

    const cached = await this.getPairInfo(position)
    if (!cached) return

    const pair = normalizeReservesFromCache(
      { reserve0, reserve1, blockTimestampLast: 0 },
      cached.info,
      WETH_ADDRESS,
      cached.isToken0Eth,
    )

    await this.evaluatePair(position, pair)
  }

  /**
   * Immutable pair info (token0/token1/decimals) used to normalize Sync payloads.
   * Sourced from position metadata (stamped at entry); legacy positions without
   * it trigger a ONE-TIME on-chain fetch, then live in memory.
   */
  private async getPairInfo(
    position: Position,
  ): Promise<{ info: CachedPairInfo; isToken0Eth: boolean } | null> {
    const existing = this.pairInfoCache.get(position.id)
    if (existing) return existing

    const meta = position.metadata as Record<string, unknown> | null
    const token0 = meta?.token0 as string | undefined
    const token1 = meta?.token1 as string | undefined
    const tokenDecimals = meta?.tokenDecimals as number | undefined
    const isToken0EthMeta = meta?.isToken0Eth as boolean | undefined

    if (token0 && token1 && tokenDecimals !== undefined) {
      const entry = {
        info: { token0, token1, tokenDecimals },
        isToken0Eth: isToken0EthMeta ?? token0.toLowerCase() === WETH_ADDRESS.toLowerCase(),
      }
      this.pairInfoCache.set(position.id, entry)
      return entry
    }

    // Legacy position — fetch immutable info once
    try {
      const contract = new Contract(position.poolAddress, UNISWAP_PAIR_ABI, rhProvider)
      const info = await getRawPairInfo(contract, rhProvider)
      if (!info) return null
      const isToken0Eth = info.token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
      const entry = {
        info: {
          token0: info.token0,
          token1: info.token1,
          tokenDecimals: isToken0Eth ? info.decimals1 : info.decimals0,
        },
        isToken0Eth,
      }
      this.pairInfoCache.set(position.id, entry)
      return entry
    } catch {
      return null
    }
  }

  // ── Position evaluation (shared between push + fallback paths) ──────────────

  /**
   * RPC fallback sweep — fetches reserves via HTTP. Covers TP/SL while the WS is
   * down, dead pairs (LP pulled), and stale-flat detection.
   */
  // NOTE: must NOT hold `inflight` around the whole check — doSell()'s first
  // guard is `inflight.has()`, so a pre-added id turns every sweep-path sell
  // (stale-flat, dead-pair, TP/SL fallback) into a silent no-op. Serialization
  // of the actual sell is doSell's own job.
  private async checkPosition(position: Position): Promise<void> {
    try {
      // Dynamic honeypot check — a token that stopped being sellable will never
      // fill an exit; carrying it as open hides an already-realized total loss.
      // fresh:true bypasses the probe cache so flips are caught within one sweep.
      const probe = await probeToken(position.tokenAddress, { fresh: true })
      if (!probe.ok && probe.error === 'revert') {
        await this.closeUnsellable(position)
        return
      }

      const pair = await this.fetchPairState(position)

      if (!pair) {
        // Reserves unreadable. A REAL dead pair (LP pulled) makes the probe
        // above revert and is closed as a total loss by closeUnsellable — so
        // reaching here means a transient RPC failure. Do NOT fabricate an
        // exit off the entry snapshot (that recorded rugs/outages as
        // break-even); just retry on the next sweep.
        log.debug(
          { positionId: position.id, poolAddress: position.poolAddress },
          'Pair reserves not available — retry next sync',
        )
        return
      }

      await this.evaluatePair(position, pair)

      // Stale-flat check (only in fallback path, not per-push)
      if (this.isStaleFlat(position, pair)) {
        const entryPrice = parseFloat(position.entryPriceNative)
        const spotPrice = pair.ethReserve / pair.tokenReserve
        const pnlPct = Number.isFinite(entryPrice) && entryPrice > 0
          ? ((spotPrice - entryPrice) / entryPrice) * 100
          : 0
        log.warn(
          {
            positionId: position.id,
            tokenAddress: position.tokenAddress.slice(0, 12),
            ageMin: Math.floor((Date.now() - position.openedAt.getTime()) / 60000),
            pnlPct: pnlPct.toFixed(2),
          },
          'STALE-FLAT — closing dormant position to free cap',
        )
        await this.doSell(position, 100, 'stale-flat', pair)
      }
    } catch (err) {
      log.error({ err, positionId: position.id }, 'Position check failed')
    }
  }

  /**
   * Evaluate TP/SL against the current pair state.
   * Shared by the Sync push path and the RPC fallback sweep.
   */
  private async evaluatePair(
    position: Position,
    pair: PairState,
  ): Promise<void> {
    const entryPrice = parseFloat(position.entryPriceNative)
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return

    const spotPrice = pair.ethReserve / pair.tokenReserve
    const pnlPct = ((spotPrice - entryPrice) / entryPrice) * 100

    // Update snapshot for dashboard
    this.snapshots.set(position.id, {
      positionId: position.id,
      tokenAddress: position.tokenAddress,
      entryPriceNative: entryPrice,
      spotPriceNative: spotPrice,
      pnlPct,
      fetchedAt: Date.now(),
    })

    const decision = this.decide(position, pair)
    if (!decision) return

    log.debug(
      {
        positionId: position.id,
        tokenAddress: position.tokenAddress.slice(0, 12),
        reason: decision.reason,
        pnlPct: decision.pnlPct.toFixed(2),
      },
      'Decision triggered',
    )

    await this.doSell(position, decision.sellPct, decision.reason, pair)
  }

  // ── Dev dump emergency handler ─────────────────────────────────────────────

  /**
   * Called by DevWalletMonitor when the deployer sells > DEV_SELL_ABANDON_PCT
   * of their initial token balance. Fetches the current pair state and fires
   * an emergency 100% sell at whatever price is available.
   *
   * Public so DevWalletMonitor can call it via the callback.
   */
  async handleDevDump(positionId: string): Promise<void> {
    if (this.inflight.has(positionId)) return

    const position = this.positionCache.get(positionId)
    if (!position) {
      log.warn({ positionId }, 'Dev dump: position not in cache — cannot sell')
      return
    }

    if (position.status === 'closed' || position.status === 'stopped') {
      log.debug({ positionId, status: position.status }, 'Dev dump: position already closed')
      return
    }

    let pair: PairState
    try {
      const fetched = await this.fetchPairState(position)
      if (!fetched) {
        log.warn({ positionId }, 'Dev dump: pair state unavailable, using entry snapshot as fallback')
        const meta = position.metadata as
          | { pairReservesSnapshot?: { ethReserve?: number; tokenReserve?: number } }
          | null
        pair = {
          ethReserve: meta?.pairReservesSnapshot?.ethReserve ?? 0,
          tokenReserve: meta?.pairReservesSnapshot?.tokenReserve ?? 0,
          tokenDecimals: 18,
        }
      } else {
        pair = fetched
      }
    } catch (err) {
      log.error({ err, positionId }, 'Dev dump: failed to fetch pair state, using entry snapshot')
      const meta = position.metadata as
        | { pairReservesSnapshot?: { ethReserve?: number; tokenReserve?: number } }
        | null
      pair = {
        ethReserve: meta?.pairReservesSnapshot?.ethReserve ?? 0,
        tokenReserve: meta?.pairReservesSnapshot?.tokenReserve ?? 0,
        tokenDecimals: 18,
      }
    }

    log.info(
      {
        positionId,
        tokenAddress: position.tokenAddress,
        ethReserve: pair.ethReserve,
        tokenReserve: pair.tokenReserve,
      },
      'DEV DUMP — executing emergency 100% sell',
    )

    await this.doSell(position, 100, 'dev-sell', pair)
  }

  // ── Shared sell + cleanup ─────────────────────────────────────────────────

  /**
   * Token stopped being sellable after entry (dynamic honeypot) — no exit will
   * ever fill, in real mode the funds would be gone. Record the honest outcome:
   * position stopped, remaining tokens written off.
   */
  private async closeUnsellable(position: Position): Promise<void> {
    const priorExit = parseFloat(position.exitAmountNative ?? '0')
    const entry = parseFloat(position.entryAmountNative)
    log.error(
      {
        positionId: position.id,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        lossNative: (priorExit - entry).toFixed(6),
      },
      'UNSELLABLE — sell simulation reverts; closing position as total loss',
    )
    await closePosition(position.id, {
      exitAmountNative: priorExit.toFixed(9),
      realizedPnlNative: (priorExit - entry).toFixed(9),
      exitTxHash: `honeypot:${Date.now()}`,
      status: 'stopped',
    })
    position.status = 'stopped'
    this.untrack(position.id)
    void sendTelegramAlert(
      `☠️ <b>HONEYPOT</b> — ${position.tokenSymbol ?? position.tokenAddress.slice(0, 10)}\n\n` +
        `Token ficou invendável após a entrada.\n` +
        `Posição encerrada como perda: <b>${(priorExit - entry).toFixed(6)} ETH</b>\n` +
        `Pos: <code>${position.id}</code>`,
    )
  }

  /**
   * Drop a position from all tracking structures and cancel its pair Sync
   * subscription. Idempotent — used by syncTick cleanup and by doSell right
   * after a full exit.
   */
  private untrack(positionId: string): void {
    this.positionCache.delete(positionId)
    this.snapshots.delete(positionId)
    this.pairInfoCache.delete(positionId)
    this.devWalletMonitor.unwatch(positionId)
    wsManager.unregister(this.syncKey(positionId))
    log.debug({ positionId }, 'Unsubscribed closed position')
  }

  private async doSell(
    position: Position,
    sellPct: number,
    reason: 'take-profit' | 'stop-loss' | 'manual' | 'stale-flat' | 'dev-sell',
    currentState: PairState,
  ): Promise<void> {
    if (this.inflight.has(position.id)) return
    if (position.status === 'closed' || position.status === 'stopped') return
    this.inflight.add(position.id)
    try {
      const result = await executorSell({
        position,
        sellPctOfPosition: sellPct,
        reason,
        currentState,
      })

      if (result.success) {
        log.info(
          {
            positionId: position.id,
            tokenAddress: position.tokenAddress,
            reason,
            sellPct,
          },
          'Position sell executed',
        )
        if (sellPct >= 100) {
          // Close in the cache and untrack before releasing inflight — waiting
          // for the next syncTick leaves a window where queued Sync pushes see
          // the stale 'open' status and fire duplicate sells.
          position.status = 'closed'
          this.untrack(position.id)
        }
      } else {
        log.warn({ positionId: position.id, error: result.error }, 'Executor rejected sell')
      }
    } finally {
      this.inflight.delete(position.id)
    }
  }

  // ── Decision ──────────────────────────────────────────────────────────────

  private decide(
    position: Position,
    pair: PairState,
  ): { sellPct: number; reason: 'take-profit' | 'stop-loss'; pnlPct: number } | null {
    const entryPrice = parseFloat(position.entryPriceNative)
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null

    const spotPrice = pair.ethReserve / pair.tokenReserve
    const pnlPct = ((spotPrice - entryPrice) / entryPrice) * 100

    const tpPct = parseFloat(position.takeProfitPct)
    const slPct = parseFloat(position.stopLossPct)

    // Stop loss — full exit
    if (pnlPct <= -slPct) {
      return { sellPct: 100, reason: 'stop-loss', pnlPct }
    }

    // Take profit — ALWAYS a full 100% exit and position close (safety policy:
    // no moonbag). Intentionally ignores the per-position sellPctAtTp so legacy
    // DB rows created with partial-TP configs also close in full.
    if (position.status === 'open' && pnlPct >= tpPct) {
      return { sellPct: 100, reason: 'take-profit', pnlPct }
    }

    return null
  }

  /**
   * A position is "stale-flat" when the pair reserves haven't budged since entry.
   * ethReserve grows on buys, shrinks on sells — identical ethReserve = zero trades.
   */
  private isStaleFlat(position: Position, pair: PairState): boolean {
    const ageMs = Date.now() - position.openedAt.getTime()
    if (ageMs < this.staleKillAgeMs) return false

    const meta = position.metadata as
      | { pairReservesSnapshot?: { ethReserve?: number } }
      | undefined
    const entryEthReserve = meta?.pairReservesSnapshot?.ethReserve
    if (typeof entryEthReserve !== 'number') return false

    const delta = Math.abs(pair.ethReserve - entryEthReserve)
    return delta < this.staleEthReserveToleranceNative
  }

  // ── Pair state fetcher (HTTP — fallback sweep + dev dump only) ─────────────

  /**
   * Fetch current pair reserves from the Uniswap V2 pair contract.
   *
   * Uses cached token0/token1/tokenDecimals from position metadata to avoid
   * redundant RPC calls — these values are IMMUTABLE in Uniswap V2 pairs,
   * so re-fetching them is pure waste.
   */
  private async fetchPairState(position: Position): Promise<PairState | null> {
    try {
      const contract = new Contract(position.poolAddress, UNISWAP_PAIR_ABI, rhProvider)
      const raw = await getRawPairReserves(contract)
      if (!raw) return null

      // Fast path: cached immutable pair info — getReserves is the only RPC call
      const cached = await this.getPairInfo(position)
      if (cached) {
        return normalizeReservesFromCache(raw, cached.info, WETH_ADDRESS, cached.isToken0Eth)
      }

      // Slow path: normalize with a fresh on-chain info fetch
      const info = await getRawPairInfo(contract, rhProvider)
      if (!info) return null
      return normalizeReserves(raw, info, WETH_ADDRESS)
    } catch {
      return null
    }
  }
}

export const positionManager = new PositionManager()
