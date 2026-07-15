CREATE TYPE "public"."position_status" AS ENUM('open', 'partial_exit', 'closed', 'stopped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."protocol" AS ENUM('pumpfun', 'raydium', 'meteora', 'jupiter');--> statement-breakpoint
CREATE TYPE "public"."trading_mode" AS ENUM('paper', 'real');--> statement-breakpoint
CREATE TABLE "paper_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"token_address" text NOT NULL,
	"side" text NOT NULL,
	"quoted_price_sol" numeric(20, 12) NOT NULL,
	"amount_sol" numeric(20, 9) NOT NULL,
	"tokens_amount" numeric(30, 0),
	"slippage_bps" integer,
	"jupiter_quote" jsonb,
	"price_impact_pct" numeric(10, 4),
	"simulated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_address" text NOT NULL,
	"token_symbol" text,
	"token_name" text,
	"pool_address" text NOT NULL,
	"protocol" "protocol" NOT NULL,
	"mode" "trading_mode" NOT NULL,
	"status" "position_status" DEFAULT 'open' NOT NULL,
	"entry_price_sol" numeric(20, 12) NOT NULL,
	"entry_amount_sol" numeric(20, 9) NOT NULL,
	"entry_tx_hash" text,
	"tokens_received" numeric(30, 0),
	"take_profit_pct" numeric(10, 4) NOT NULL,
	"sell_pct_at_tp" numeric(10, 4) NOT NULL,
	"stop_loss_pct" numeric(10, 4) NOT NULL,
	"realized_pnl_sol" numeric(20, 9) DEFAULT '0' NOT NULL,
	"exit_amount_sol" numeric(20, 9) DEFAULT '0' NOT NULL,
	"exit_tx_hash" text,
	"is_moonbag" boolean DEFAULT false NOT NULL,
	"moonbag_tokens" numeric(30, 0),
	"risk_score" integer,
	"risk_level" text,
	"risk_flags" jsonb,
	"strategy_name" text,
	"signal_id" text,
	"metadata" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_trades" ADD CONSTRAINT "paper_trades_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;