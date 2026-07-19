import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// ── Enums ─────────────────────────────────────────────────────────────────────

export const positionStatusEnum = pgEnum('position_status', [
  'open',         // Active, monitoring PnL
  'partial_exit', // Take profit executed, moonbag still open
  'closed',       // Fully closed (TP, manual sell, stop loss)
  'stopped',      // Closed by stop loss
  'failed',       // Entry tx failed or rejected
])

export const tradingModeEnum = pgEnum('trading_mode', ['paper', 'real'])

export const protocolEnum = pgEnum('protocol', [
  'pumpfun',
  'robbinhood',
  'uniswap',
])

// ── positions ─────────────────────────────────────────────────────────────────
// One row per opened position (paper or real)

export const positions = pgTable('positions', {
  id: uuid('id').defaultRandom().primaryKey(),

  // Token identification
  tokenAddress: text('token_address').notNull(),
  tokenSymbol: text('token_symbol'),
  tokenName: text('token_name'),
  poolAddress: text('pool_address').notNull(),
  protocol: protocolEnum('protocol').notNull(),

  // Mode: paper | real
  mode: tradingModeEnum('mode').notNull(),
  status: positionStatusEnum('status').notNull().default('open'),

  // ── Entry ───────────────────────────────────────────────────────────────────
  // Prices stored as numeric strings to avoid floating-point loss
  entryPriceNative: numeric('entry_price_native', { precision: 20, scale: 12 }).notNull(),
  entryAmountNative: numeric('entry_amount_native', { precision: 20, scale: 9 }).notNull(),
  entryTxHash: text('entry_tx_hash'), // null in paper mode
  tokensReceived: numeric('tokens_received', { precision: 30, scale: 0 }), // raw token units

  // ── TP / SL config snapshot ─────────────────────────────────────────────────
  // Captured at entry time so changing config doesn't affect existing positions
  takeProfitPct: numeric('take_profit_pct', { precision: 10, scale: 4 }).notNull(),
  sellPctAtTp: numeric('sell_pct_at_tp', { precision: 10, scale: 4 }).notNull(),
  stopLossPct: numeric('stop_loss_pct', { precision: 10, scale: 4 }).notNull(),

  // ── Realized ────────────────────────────────────────────────────────────────
  realizedPnlNative: numeric('realized_pnl_native', { precision: 20, scale: 9 }).notNull().default('0'),
  exitAmountNative: numeric('exit_amount_native', { precision: 20, scale: 9 }).notNull().default('0'),
  exitTxHash: text('exit_tx_hash'),

  // ── Moonbag ─────────────────────────────────────────────────────────────────
  isMoonbag: boolean('is_moonbag').notNull().default(false),
  moonbagTokens: numeric('moonbag_tokens', { precision: 30, scale: 0 }),

  // ── Peak-price instrumentation ──────────────────────────────────────────────
  // Highest post-entry spot price observed while the position was tracked, plus
  // when it happened. Lets us measure how far winners actually run (peak / entry
  // = multiple) to calibrate a moonbag / trailing-stop. Null until price first
  // exceeds entry.
  peakPriceNative: numeric('peak_price_native', { precision: 20, scale: 12 }),
  peakAt: timestamp('peak_at', { withTimezone: true }),

  // ── Risk snapshot at entry ──────────────────────────────────────────────────
  riskScore: integer('risk_score'),      // 0-100
  riskLevel: text('risk_level'),         // 'low' | 'medium' | 'high' | 'critical'
  riskFlags: jsonb('risk_flags').$type<string[]>(),

  // ── Strategy metadata ───────────────────────────────────────────────────────
  strategyName: text('strategy_name'),
  signalId: text('signal_id'),

  // ── Free-form metadata ──────────────────────────────────────────────────────
  // Store deployer address, initial liquidity, extra on-chain data here
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // ── Timestamps ──────────────────────────────────────────────────────────────
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ── paper_trades ──────────────────────────────────────────────────────────────
// One row per simulated buy/sell event in paper mode.
// Linked to a position; stores the bonding curve quote used for the simulation.

export const paperTrades = pgTable('paper_trades', {
  id: uuid('id').defaultRandom().primaryKey(),
  positionId: uuid('position_id')
    .references(() => positions.id, { onDelete: 'cascade' })
    .notNull(),

  tokenAddress: text('token_address').notNull(),
  side: text('side', { enum: ['buy', 'sell'] }).notNull(),

  // Price used for the simulation (from on-chain bonding curve state)
  quotedPriceNative: numeric('quoted_price_native', { precision: 20, scale: 12 }).notNull(),
  amountNative: numeric('amount_native', { precision: 20, scale: 9 }).notNull(),
  tokensAmount: numeric('tokens_amount', { precision: 30, scale: 0 }),
  slippageBps: integer('slippage_bps'),

  // Full on-chain quote snapshot — useful for post-analysis
  quoteSnapshot: jsonb('quote_snapshot').$type<Record<string, unknown>>(),

  // Whether this trade would have landed well (filled at quoted price ± threshold)
  priceImpactPct: numeric('price_impact_pct', { precision: 10, scale: 4 }),

  simulatedAt: timestamp('simulated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ── deployer_blacklist ────────────────────────────────────────────────────────
// Wallets known to deploy rugs / scams. Populated manually + by analytics jobs.

export const deployerBlacklist = pgTable('deployer_blacklist', {
  address: text('address').primaryKey(),
  reason: text('reason').notNull(),
  severity: text('severity', { enum: ['low', 'medium', 'high', 'critical'] })
    .notNull()
    .default('high'),
  // Evidence: array of tx hashes, related token addresses, links
  evidence: jsonb('evidence').$type<Record<string, unknown>>(),
  addedBy: text('added_by'), // 'manual' | 'auto:rug-detector' | 'auto:deployer-history' etc.
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
})

// ── risk_evaluations ──────────────────────────────────────────────────────────
// Audit trail for every candidate evaluated. Lets us reconstruct WHY a token
// was approved or rejected even months later.

export const riskEvaluations = pgTable('risk_evaluations', {
  id: uuid('id').defaultRandom().primaryKey(),
  candidateId: text('candidate_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  poolAddress: text('pool_address').notNull(),
  deployerAddress: text('deployer_address').notNull(),
  protocol: protocolEnum('protocol').notNull(),

  passed: boolean('passed').notNull(),
  riskScore: integer('risk_score').notNull(),
  riskLevel: text('risk_level', {
    enum: ['low', 'medium', 'high', 'critical'],
  }).notNull(),

  // Flags: ordered list of triggered check names (e.g. ['mint-auth-not-revoked'])
  flags: jsonb('flags').$type<string[]>().notNull(),

  // checksDetail: per-check breakdown {checkName: {passed, score, detail}}
  checksDetail: jsonb('checks_detail')
    .$type<Record<string, { passed: boolean; score: number; detail?: string }>>()
    .notNull(),

  evaluationDurationMs: integer('evaluation_duration_ms'),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ── Relations ─────────────────────────────────────────────────────────────────

export const positionsRelations = relations(positions, ({ many }) => ({
  paperTrades: many(paperTrades),
}))

export const paperTradesRelations = relations(paperTrades, ({ one }) => ({
  position: one(positions, {
    fields: [paperTrades.positionId],
    references: [positions.id],
  }),
}))

// ── Inferred types ────────────────────────────────────────────────────────────

export type Position = typeof positions.$inferSelect
export type NewPosition = typeof positions.$inferInsert
export type PaperTrade = typeof paperTrades.$inferSelect
export type NewPaperTrade = typeof paperTrades.$inferInsert
export type DeployerBlacklistEntry = typeof deployerBlacklist.$inferSelect
export type NewDeployerBlacklistEntry = typeof deployerBlacklist.$inferInsert
export type RiskEvaluation = typeof riskEvaluations.$inferSelect
export type NewRiskEvaluation = typeof riskEvaluations.$inferInsert

export type PositionStatus = Position['status']
export type TradingMode = Position['mode']
export type Protocol = Position['protocol']
