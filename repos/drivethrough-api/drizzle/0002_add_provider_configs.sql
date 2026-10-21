CREATE TABLE IF NOT EXISTS "provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider_kind" NOT NULL,
	"client_id_enc" text,
	"client_secret_enc" text,
	"redirect_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_configs_provider_unique" UNIQUE("provider")
);
