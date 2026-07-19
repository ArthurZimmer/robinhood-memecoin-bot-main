import { and, count, eq, gte, isNull, sql } from 'drizzle-orm'
import { db } from '../database/client.js'
import {
  paperTrades,
  positions,
  type NewPaperTrade,
  type NewPosition,
  type Position,
} from '../database/schema.js'

// ── Position repository ──────────────────────────────────────────────────────
// Thin wrapper around Drizzle queries — keeps SQL in one place.

export async function insertPosition(row: NewPosition): Promise<Position> {
  const [inserted] = await db.insert(positions).values(row).returning()
  if (!inserted) throw new Error('insertPosition returned no row')
  return inserted
}

export async function insertPaperTrade(row: NewPaperTrade): Promise<void> {
  await db.insert(paperTrades).values(row)
}

export async function countOpenPositions(mode: 'paper' | 'real'): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(positions)
    .where(and(eq(positions.mode, mode), isNull(positions.closedAt)))
  return row?.n ?? 0
}

/**
 * Sum of realized PnL (native) for positions closed since the start of today (UTC).
 * Returns a NEGATIVE number when in drawdown.
 */
export async function todayRealizedPnlNative(mode: 'paper' | 'real'): Promise<number> {
  const startOfDay = new Date()
  startOfDay.setUTCHours(0, 0, 0, 0)

  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${positions.realizedPnlNative}), 0)`,
    })
    .from(positions)
    .where(and(eq(positions.mode, mode), gte(positions.closedAt, startOfDay)))

  return row ? parseFloat(row.total) : 0
}

/**
 * Counts positions with this symbol closed IN PROFIT within the lookback
 * window. Rug factories relaunch the ticker of a token that just pumped
 * (often one we took profit on) and pull the LP minutes later — a recent
 * profitable close on the same symbol marks the relaunch as bait.
 */
export async function countRecentProfitableClosesBySymbol(
  mode: 'paper' | 'real',
  symbol: string,
  sinceMs: number,
): Promise<number> {
  const since = new Date(Date.now() - sinceMs)
  const [row] = await db
    .select({ n: count() })
    .from(positions)
    .where(
      and(
        eq(positions.mode, mode),
        eq(positions.tokenSymbol, symbol),
        gte(positions.closedAt, since),
        sql`${positions.realizedPnlNative}::numeric > 0`,
      ),
    )
  return row?.n ?? 0
}

export async function findPositionById(id: string): Promise<Position | null> {
  const [row] = await db.select().from(positions).where(eq(positions.id, id)).limit(1)
  return row ?? null
}

export async function findOpenPositionByToken(
  mode: 'paper' | 'real',
  tokenAddress: string,
): Promise<Position | null> {
  const [row] = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.mode, mode),
        eq(positions.tokenAddress, tokenAddress),
        isNull(positions.closedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Returns all positions where status is 'open' or 'partial_exit'
 * (moonbag still being tracked). Excludes fully closed/stopped/failed.
 */
export async function listActivePositions(mode: 'paper' | 'real'): Promise<Position[]> {
  return db
    .select()
    .from(positions)
    .where(and(eq(positions.mode, mode), isNull(positions.closedAt)))
}

/**
 * Records a new post-entry price high for a position (peak-price instrumentation).
 * Idempotent + race-safe: the WHERE guard only writes when the incoming price
 * beats the stored peak (or none exists), so out-of-order pushes never lower it.
 */
export async function recordPeakPrice(
  positionId: string,
  peakPriceNative: string,
): Promise<void> {
  await db
    .update(positions)
    .set({ peakPriceNative, peakAt: new Date() })
    .where(
      and(
        eq(positions.id, positionId),
        sql`(${positions.peakPriceNative} IS NULL OR ${positions.peakPriceNative}::numeric < ${peakPriceNative}::numeric)`,
      ),
    )
}

export async function markPartialExit(
  positionId: string,
  delta: {
    exitAmountNative: string
    realizedPnlNative: string
    moonbagTokens: string
  },
): Promise<void> {
  await db
    .update(positions)
    .set({
      status: 'partial_exit',
      isMoonbag: true,
      exitAmountNative: delta.exitAmountNative,
      realizedPnlNative: delta.realizedPnlNative,
      moonbagTokens: delta.moonbagTokens,
      updatedAt: new Date(),
    })
    .where(eq(positions.id, positionId))
}

export async function closePosition(
  positionId: string,
  delta: {
    exitAmountNative: string
    realizedPnlNative: string
    exitTxHash?: string
    status: 'closed' | 'stopped' | 'failed'
  },
): Promise<void> {
  const now = new Date()
  await db
    .update(positions)
    .set({
      status: delta.status,
      exitAmountNative: delta.exitAmountNative,
      realizedPnlNative: delta.realizedPnlNative,
      ...(delta.exitTxHash && { exitTxHash: delta.exitTxHash }),
      moonbagTokens: '0',
      closedAt: now,
      updatedAt: now,
    })
    .where(eq(positions.id, positionId))
}
