import { and, count, eq, gte, isNull, ne, sql } from 'drizzle-orm'
import { db } from '../database/client.js'
import {
  paperTrades,
  positions,
  riskEvaluations,
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

/**
 * How many OTHER tokens this deployer launched within the lookback.
 * The candidate itself is excluded on purpose: its own risk_evaluations row
 * is written fire-and-forget, so including it would make the count race.
 * Sourced from risk_evaluations (every candidate ever evaluated) rather than the
 * Redis deployer counter, whose 1h TTL makes it a "launches this hour" gauge.
 */
export async function countPriorDeployerLaunches(
  deployerAddress: string,
  excludeTokenAddress: string,
  sinceMs: number,
): Promise<number> {
  const since = new Date(Date.now() - sinceMs)
  const [row] = await db
    .select({ n: sql<string>`COUNT(DISTINCT ${riskEvaluations.tokenAddress})` })
    .from(riskEvaluations)
    .where(
      and(
        eq(riskEvaluations.deployerAddress, deployerAddress),
        gte(riskEvaluations.evaluatedAt, since),
        ne(riskEvaluations.tokenAddress, excludeTokenAddress),
      ),
    )
  return row ? parseInt(row.n, 10) : 0
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
