CREATE TABLE "deployer_blacklist" (
	"address" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"severity" text DEFAULT 'high' NOT NULL,
	"evidence" jsonb,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" text NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"deployer_address" text NOT NULL,
	"protocol" "protocol" NOT NULL,
	"passed" boolean NOT NULL,
	"risk_score" integer NOT NULL,
	"risk_level" text NOT NULL,
	"flags" jsonb NOT NULL,
	"checks_detail" jsonb NOT NULL,
	"evaluation_duration_ms" integer,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
