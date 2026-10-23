CREATE TABLE IF NOT EXISTS "rate_limits" (
	"bucket" varchar(255) PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_user" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_tokens_expires" ON "preview_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shares_file" ON "shares" USING btree ("file_id");