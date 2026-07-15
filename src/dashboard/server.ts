import http from 'node:http'
import { Contract } from 'ethers'
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { env } from '../config/env.js'
import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
import { db } from '../database/client.js'
import {
  positions,
  riskEvaluations,
  paperTrades,
} from '../database/schema.js'
import { positionManager } from '../positions/position-manager.js'
import { paperExecutor } from '../executor/paper.executor.js'
import { realExecutor } from '../executor/real.executor.js'
import { rhProvider } from '../utils/robbinhood.utils.js'
import { getBotAddress } from '../utils/wallet.js'
import {
  getRawPairInfo,
  getRawPairReserves,
  normalizeReserves,
  type PairState,
} from '../executor/uniswap-math.js'
import { WETH_ADDRESS } from '../utils/robbinhood.utils.js'
import { findPositionById } from '../positions/position.repository.js'
import { dashboardHtmlPaper, dashboardHtmlReal } from './ui.js'

const log = createChildLogger('dashboard')

// Market cap = price × total supply. Total supply is stored in position metadata
// (populated at buy time from the source event). If absent, MC is shown as null.

// ETH/USD price cache — refreshed lazily, max one fetch per 60s.
let ethUsdCache: { price: number; fetchedAt: number } | null = null
const ETH_USD_TTL_MS = 60_000

async function getEthUsd(): Promise<number> {
  const now = Date.now()
  if (ethUsdCache && now - ethUsdCache.fetchedAt < ETH_USD_TTL_MS) {
    return ethUsdCache.price
  }
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(3_000) },
    )
    if (!res.ok) throw new Error(`coingecko ${res.status}`)
    const json = (await res.json()) as { ethereum?: { usd?: number } }
    const price = json.ethereum?.usd
    if (typeof price !== 'number' || price <= 0) throw new Error('invalid price')
    ethUsdCache = { price, fetchedAt: now }
    // Share ETH price with rest of pipeline (strategy MC check reads this)
    eventBus.client.set('cache:eth_usd', String(price), 'EX', 120).catch(() => undefined)
    return price
  } catch (err) {
    log.warn({ err }, 'ETH/USD fetch failed, using cached or fallback')
    return ethUsdCache?.price ?? 0
  }
}

// ── Dashboard HTTP server ────────────────────────────────────────────────────
// Zero external deps (uses Node `http`). Polling-based — client fetches /api/*
// every 2s. For higher fidelity later, swap to SSE.

interface ApiStreamCounts {
  raw: number
  parsed: number
  candidates: number
  approved: number
  signals: number
  positions: number
}

export class DashboardServer {
  private server: http.Server | null = null
  private readonly startTime = Date.now()
  private readonly port: number

  constructor(port?: number) {
    this.port = port ?? env.PORT
  }

  async start(): Promise<void> {
    if (this.server) {
      log.warn('start() called but already running')
      return
    }
    this.server = http.createServer((req, res) => this.handle(req, res).catch((err) => {
      log.error({ err, url: req.url }, 'Request handler error')
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal_error' }))
      } catch {
        // Connection might already be closed
      }
    }))

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.port, () => resolve())
    })
    log.info({ url: `http://localhost:${this.port}` }, 'Dashboard available')
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve())
    })
    this.server = null
    log.info('Dashboard stopped')
  }

  // ── Router ─────────────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/'

    if (url === '/' || url === '/index.html') {
      const html = env.TRADING_MODE === 'paper' ? dashboardHtmlPaper : dashboardHtmlReal
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // Explicit dashboard routes — allows viewing either dashboard regardless of mode
    if (url === '/paper') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(dashboardHtmlPaper)
      return
    }
    if (url === '/real') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(dashboardHtmlReal)
      return
    }

    if (url === '/api/status') return this.json(res, await this.getStatus())
    if (url === '/api/streams') return this.json(res, await this.getStreamCounts())
    if (url === '/api/positions/open') return this.json(res, await this.getOpenPositions())
    if (url === '/api/positions/closed') return this.json(res, await this.getClosedPositions())
    if (url === '/api/recent') return this.json(res, await this.getRecentEvaluations())
    if (url === '/api/stats/today') return this.json(res, await this.getTodayStats())
    if (url === '/api/paper/stats') return this.json(res, await this.getPaperStats())

    // Manual sell — POST /api/positions/:id/sell?pct=100
    const sellMatch = /^\/api\/positions\/([^/?]+)\/sell/.exec(url)
    if (req.method === 'POST' && sellMatch) {
      const id = sellMatch[1]!
      const pct = Math.min(100, Math.max(1, parseInt(new URL(url, 'http://x').searchParams.get('pct') ?? '100', 10)))
      return this.json(res, await this.handleManualSell(id, pct))
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found', url }))
  }

  private json(res: http.ServerResponse, payload: unknown): void {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  // ── Data fetchers ──────────────────────────────────────────────────────────

  private async getStatus(): Promise<Record<string, unknown>> {
    const uptimeMs = Date.now() - this.startTime
    const ethUsd = await getEthUsd()

    // Paper "balance" = configured balance - sum(open entry) + sum(realized PnL)
    let walletBalanceNative: number
    if (env.TRADING_MODE === 'paper') {
      const rows = await db
        .select({
          openLocked: sql<string>`COALESCE(SUM(CASE WHEN closed_at IS NULL THEN entry_amount_native::numeric - exit_amount_native::numeric ELSE 0 END), 0)`,
          realized: sql<string>`COALESCE(SUM(CASE WHEN closed_at IS NOT NULL THEN realized_pnl_native::numeric ELSE 0 END), 0)`,
        })
        .from(positions)
        .where(eq(positions.mode, 'paper'))
      const locked = parseFloat(rows[0]?.openLocked ?? '0')
      const rPnl = parseFloat(rows[0]?.realized ?? '0')
      walletBalanceNative = env.PAPER_BALANCE_NATIVE - locked + rPnl
    } else {
      // Real mode — query on-chain wallet balance
      walletBalanceNative = 0
      const address = getBotAddress()
      if (address) {
        try {
          const wei = await rhProvider.getBalance(address)
          walletBalanceNative = Number(wei) / 1e18
        } catch (err) {
          log.warn({ err }, 'getBalance RPC call failed — showing 0')
          walletBalanceNative = 0
        }
      }
    }

    // Paper-specific aggregated metrics
    let allTimePaperPnl = 0
    let totalPaperTrades = 0
    let paperWinRate: string | null = null
    if (env.TRADING_MODE === 'paper') {
      const [pnlRow, tradesRow, winsRow, closedRow] = await Promise.all([
        db
          .select({
            realized: sql<string>`COALESCE(SUM(realized_pnl_native::numeric), 0)`,
          })
          .from(positions)
          .where(
            and(eq(positions.mode, 'paper'), isNotNull(positions.closedAt)),
          ),
        db
          .select({
            count: sql<string>`COUNT(*)`,
          })
          .from(paperTrades),
        db
          .select({
            count: sql<string>`COUNT(*)`,
          })
          .from(positions)
          .where(
            and(
              eq(positions.mode, 'paper'),
              isNotNull(positions.closedAt),
              sql`${positions.realizedPnlNative}::numeric > 0`,
            ),
          ),
        db
          .select({
            count: sql<string>`COUNT(*)`,
          })
          .from(positions)
          .where(
            and(eq(positions.mode, 'paper'), isNotNull(positions.closedAt)),
          ),
      ])
      allTimePaperPnl = parseFloat(pnlRow[0]?.realized ?? '0')
      totalPaperTrades = parseInt(tradesRow[0]?.count ?? '0', 10)
      const closedCount = parseInt(closedRow[0]?.count ?? '0', 10)
      const winCount = parseInt(winsRow[0]?.count ?? '0', 10)
      paperWinRate = closedCount > 0 ? ((winCount / closedCount) * 100).toFixed(1) : null
    }

    return {
      mode: env.TRADING_MODE,
      uptimeMs,
      uptimeHuman: humanDuration(uptimeMs),
      nodeEnv: env.NODE_ENV,
      walletBalanceNative,
      walletBalanceUsd: ethUsd > 0 ? walletBalanceNative * ethUsd : null,
      paperBalanceNative: env.PAPER_BALANCE_NATIVE,
      tradeSizeNative: env.TRADE_SIZE_NATIVE,
      maxOpenPositions: env.MAX_OPEN_POSITIONS,
      takeProfitPct: env.TAKE_PROFIT_PCT,
      stopLossPct: env.STOP_LOSS_PCT,
      minEntryMcUsd: env.MIN_ENTRY_MC_USD,
      ethUsd,
      allTimePaperPnl,
      totalPaperTrades,
      paperWinRate,
    }
  }

  private async getStreamCounts(): Promise<ApiStreamCounts> {
    const r = eventBus.client
    const [raw, parsed, candidates, approved, signals, posStream] = await Promise.all([
      r.xlen('events:raw').catch(() => 0),
      r.xlen('events:parsed').catch(() => 0),
      r.xlen('events:candidates').catch(() => 0),
      r.xlen('events:approved').catch(() => 0),
      r.xlen('events:signals').catch(() => 0),
      r.xlen('events:positions').catch(() => 0),
    ])
    return {
      raw,
      parsed,
      candidates,
      approved,
      signals,
      positions: posStream,
    }
  }

  private async getOpenPositions(): Promise<unknown[]> {
    const rows = await db
      .select()
      .from(positions)
      .where(
        and(eq(positions.mode, env.TRADING_MODE), isNull(positions.closedAt)),
      )
      .orderBy(desc(positions.openedAt))

    const ethUsd = await getEthUsd()

    return rows.map((row) => {
      const snap = positionManager.getSnapshot(row.id)
      const entry = parseFloat(row.entryPriceNative)
      // When no live snapshot yet, show entry price as estimated current (dim in UI)
      const isEstimated = snap === undefined
      const spot = snap?.spotPriceNative ?? (isEstimated ? entry : undefined)
      const pnlPct = snap?.pnlPct ?? null // no false PnL when estimated

      // Token decimals come from position metadata (stamped at entry). The old
      // hardcoded 1e6 was a Solana leftover — with 18-decimals ERC-20s it
      // inflated unrealized PnL by 10^12.
      const meta = row.metadata as { totalSupply?: string; tokenDecimals?: number } | null
      const tokenDecimals = meta?.tokenDecimals ?? 18

      const unrealizedPnlNative =
        spot !== undefined && !isEstimated && row.tokensReceived
          ? (spot - entry) * (Number(BigInt(row.tokensReceived)) / 10 ** tokenDecimals)
          : null

      // Market cap = price × total supply. Total supply stored in position metadata.
      const totalSupplyNum = meta?.totalSupply
        ? Number(meta.totalSupply) / 10 ** tokenDecimals
        : null
      const entryMarketCapNative = totalSupplyNum !== null ? entry * totalSupplyNum : null
      const currentMarketCapNative =
        spot !== undefined && totalSupplyNum !== null ? spot * totalSupplyNum : null
      const entryMarketCapUsd =
        entryMarketCapNative !== null && ethUsd > 0 ? entryMarketCapNative * ethUsd : null
      const currentMarketCapUsd =
        currentMarketCapNative !== null && ethUsd > 0 ? currentMarketCapNative * ethUsd : null

      return {
        id: row.id,
        tokenSymbol: row.tokenSymbol,
        tokenAddress: row.tokenAddress,
        protocol: row.protocol,
        status: row.status,
        isMoonbag: row.isMoonbag,
        entryAmountNative: parseFloat(row.entryAmountNative),
        entryPriceNative: entry,
        spotPriceNative: spot ?? null,
        entryMarketCapNative,
        currentMarketCapNative,
        entryMarketCapUsd,
        currentMarketCapUsd,
        pnlPct,
        unrealizedPnlNative,
        isEstimated,
        riskScore: row.riskScore,
        openedAt: row.openedAt.toISOString(),
        ageMs: Date.now() - row.openedAt.getTime(),
      }
    })
  }

  private async getClosedPositions(): Promise<unknown[]> {
    const rows = await db
      .select()
      .from(positions)
      .where(
        and(eq(positions.mode, env.TRADING_MODE), isNotNull(positions.closedAt)),
      )
      .orderBy(desc(positions.closedAt))
      .limit(20)

    return rows.map((row) => ({
      id: row.id,
      tokenSymbol: row.tokenSymbol,
      tokenAddress: row.tokenAddress,
      status: row.status,
      entryAmountNative: parseFloat(row.entryAmountNative),
      exitAmountNative: parseFloat(row.exitAmountNative ?? '0'),
      realizedPnlNative: parseFloat(row.realizedPnlNative ?? '0'),
      pnlPct: (() => {
        const e = parseFloat(row.entryAmountNative)
        const r = parseFloat(row.realizedPnlNative ?? '0')
        return e > 0 ? (r / e) * 100 : 0
      })(),
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      durationMs: row.closedAt ? row.closedAt.getTime() - row.openedAt.getTime() : null,
    }))
  }

  private async getRecentEvaluations(): Promise<unknown[]> {
    const rows = await db
      .select({
        id: riskEvaluations.id,
        tokenAddress: riskEvaluations.tokenAddress,
        passed: riskEvaluations.passed,
        riskScore: riskEvaluations.riskScore,
        riskLevel: riskEvaluations.riskLevel,
        flags: riskEvaluations.flags,
        evaluationDurationMs: riskEvaluations.evaluationDurationMs,
        evaluatedAt: riskEvaluations.evaluatedAt,
      })
      .from(riskEvaluations)
      .orderBy(desc(riskEvaluations.evaluatedAt))
      .limit(30)

    return rows.map((row) => ({
      tokenAddress: row.tokenAddress,
      passed: row.passed,
      riskScore: row.riskScore,
      riskLevel: row.riskLevel,
      flags: row.flags ?? [],
      durationMs: row.evaluationDurationMs,
      evaluatedAt: row.evaluatedAt.toISOString(),
      ageMs: Date.now() - row.evaluatedAt.getTime(),
    }))
  }

  private async getTodayStats(): Promise<Record<string, unknown>> {
    const startOfDay = new Date()
    startOfDay.setUTCHours(0, 0, 0, 0)

    const riskRows = await db
      .select({
        riskTotal: sql<string>`COUNT(*)`,
        riskPassed: sql<string>`COALESCE(SUM(CASE WHEN passed THEN 1 ELSE 0 END), 0)`,
      })
      .from(riskEvaluations)
      .where(sql`${riskEvaluations.evaluatedAt} >= ${startOfDay}`)

    // Count buys/sells from positions table — works for both paper and real mode.
    const tradeRows = await db
      .select({
        buys: sql<string>`COALESCE(COUNT(*), 0)`,
        sells: sql<string>`COALESCE(SUM(CASE WHEN closed_at IS NOT NULL THEN 1 ELSE 0 END), 0)`,
      })
      .from(positions)
      .where(
        sql`${positions.mode} = ${env.TRADING_MODE} AND ${positions.openedAt} >= ${startOfDay}`,
      )

    const pnlRows = await db
      .select({
        realized: sql<string>`COALESCE(SUM(realized_pnl_native::numeric), 0)`,
      })
      .from(positions)
      .where(
        sql`${positions.mode} = ${env.TRADING_MODE} AND ${positions.closedAt} >= ${startOfDay}`,
      )

    return {
      tokensEvaluated: parseInt(riskRows[0]?.riskTotal ?? '0', 10),
      tokensApproved: parseInt(riskRows[0]?.riskPassed ?? '0', 10),
      buys: parseInt(tradeRows[0]?.buys ?? '0', 10),
      sells: parseInt(tradeRows[0]?.sells ?? '0', 10),
      realizedPnlNative: parseFloat(pnlRows[0]?.realized ?? '0'),
    }
  }

  // ── Paper-specific stats ──────────────────────────────────────────────────

  private async getPaperStats(): Promise<Record<string, unknown>> {
    const startOfDay = new Date()
    startOfDay.setUTCHours(0, 0, 0, 0)

    // All-time paper metrics
    const allTime = await db
      .select({
        totalTrades: sql<string>`COUNT(*)`,
        totalBuys: sql<string>`COALESCE(SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END), 0)`,
        totalSells: sql<string>`COALESCE(SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END), 0)`,
        totalVolumeNative: sql<string>`COALESCE(SUM(amount_native::numeric), 0)`,
      })
      .from(paperTrades)

    // All-time PnL
    const pnlAllTime = await db
      .select({
        realized: sql<string>`COALESCE(SUM(realized_pnl_native::numeric), 0)`,
        closed: sql<string>`COUNT(*)`,
      })
      .from(positions)
      .where(
        and(
          eq(positions.mode, 'paper'),
          isNotNull(positions.closedAt),
        ),
      )

    // Win rate
    const wins = await db
      .select({
        count: sql<string>`COUNT(*)`,
      })
      .from(positions)
      .where(
        and(
          eq(positions.mode, 'paper'),
          isNotNull(positions.closedAt),
          sql`${positions.realizedPnlNative}::numeric > 0`,
        ),
      )

    const closedCount = parseInt(pnlAllTime[0]?.closed ?? '0', 10)
    const winCount = parseInt(wins[0]?.count ?? '0', 10)
    const winRate = closedCount > 0 ? ((winCount / closedCount) * 100).toFixed(1) : '0'

    // Today trades
    const todayTrades = await db
      .select({
        count: sql<string>`COUNT(*)`,
      })
      .from(paperTrades)
      .where(sql`${paperTrades.simulatedAt} >= ${startOfDay}`)

    // Open positions count
    const openCount = await db
      .select({
        count: sql<string>`COUNT(*)`,
      })
      .from(positions)
      .where(
        and(eq(positions.mode, 'paper'), isNull(positions.closedAt)),
      )

    return {
      allTimeTrades: parseInt(allTime[0]?.totalTrades ?? '0', 10),
      allTimeBuys: parseInt(allTime[0]?.totalBuys ?? '0', 10),
      allTimeSells: parseInt(allTime[0]?.totalSells ?? '0', 10),
      allTimeVolumeNative: parseFloat(allTime[0]?.totalVolumeNative ?? '0'),
      allTimeRealizedPnlNative: parseFloat(pnlAllTime[0]?.realized ?? '0'),
      closedPositions: closedCount,
      winCount,
      winRate,
      todayTrades: parseInt(todayTrades[0]?.count ?? '0', 10),
      openPositions: parseInt(openCount[0]?.count ?? '0', 10),
    }
  }

  // ── Manual sell ──────────────────────────────────────────────────────────────

  private async handleManualSell(
    id: string,
    pct: number,
  ): Promise<Record<string, unknown>> {
    const position = await findPositionById(id)
    if (!position) return { success: false, error: 'position not found' }
    if (position.closedAt) return { success: false, error: 'position already closed' }

    // Best-effort live pair reserve fetch; fall back to entry pair from metadata
    let pairState: PairState
    try {
      const contract = new Contract(
        position.poolAddress,
        ['function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
         'function token0() view returns (address)',
         'function token1() view returns (address)'],
        rhProvider,
      )
      const raw = await getRawPairReserves(contract)
      const info = await getRawPairInfo(contract, rhProvider)
      if (raw && info) {
        pairState = normalizeReserves(raw, info, WETH_ADDRESS)
      } else {
        throw new Error('pair state null')
      }
    } catch {
      const meta = position.metadata as
        | { pairReservesSnapshot?: { ethReserve?: number; tokenReserve?: number } }
        | null
      pairState = {
        ethReserve: meta?.pairReservesSnapshot?.ethReserve ?? 0,
        tokenReserve: meta?.pairReservesSnapshot?.tokenReserve ?? 0,
        tokenDecimals: 18,
      }
    }

    const activeExecutor = env.TRADING_MODE === 'real' ? realExecutor : paperExecutor
    const result = await (activeExecutor as typeof paperExecutor).sell({
      position,
      sellPctOfPosition: pct,
      reason: 'manual',
      currentState: pairState,
    })

    log.info(
      { id, pct, success: result.success, pnl: result.outputAmount },
      'Manual sell via dashboard',
    )

    return {
      success: result.success,
      realizedPnlNative: result.outputAmount,
      txHash: result.txSignature,
      error: result.error,
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export const dashboardServer = new DashboardServer()
