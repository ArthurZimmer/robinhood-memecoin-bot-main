-- Migration 0002: Rename Solana-era columns to EVM/native convention
-- The initial schema was generated for Solana (SOL as native currency).
-- Robinhood Chain uses ETH as native — column suffixes changed from _sol to _native.

-- positions table: rename _sol → _native
ALTER TABLE "positions" RENAME COLUMN "entry_price_sol" TO "entry_price_native";
ALTER TABLE "positions" RENAME COLUMN "entry_amount_sol" TO "entry_amount_native";
ALTER TABLE "positions" RENAME COLUMN "realized_pnl_sol" TO "realized_pnl_native";
ALTER TABLE "positions" RENAME COLUMN "exit_amount_sol" TO "exit_amount_native";

-- paper_trades table: rename _sol → _native + jupiter_quote → quote_snapshot
ALTER TABLE "paper_trades" RENAME COLUMN "quoted_price_sol" TO "quoted_price_native";
ALTER TABLE "paper_trades" RENAME COLUMN "amount_sol" TO "amount_native";
ALTER TABLE "paper_trades" RENAME COLUMN "jupiter_quote" TO "quote_snapshot";
--> statement-breakpoint

-- Add Robinhood Chain protocol enum values (cannot drop old Solana values safely)
ALTER TYPE "protocol" ADD VALUE 'robbinhood';
--> statement-breakpoint
ALTER TYPE "protocol" ADD VALUE 'uniswap';
