ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "peak_price_native" numeric(20, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "peak_at" timestamp with time zone;
