ALTER TABLE "public"."positions" ALTER COLUMN "protocol" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "public"."risk_evaluations" ALTER COLUMN "protocol" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."protocol";--> statement-breakpoint
CREATE TYPE "public"."protocol" AS ENUM('pumpfun', 'robbinhood', 'uniswap');--> statement-breakpoint
ALTER TABLE "public"."positions" ALTER COLUMN "protocol" SET DATA TYPE "public"."protocol" USING "protocol"::"public"."protocol";--> statement-breakpoint
ALTER TABLE "public"."risk_evaluations" ALTER COLUMN "protocol" SET DATA TYPE "public"."protocol" USING "protocol"::"public"."protocol";