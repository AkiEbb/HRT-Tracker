CREATE TABLE "credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_ct" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"created_by" text,
	"used_by" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "records" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"taken_at" bigint NOT NULL,
	"rev" bigint NOT NULL,
	"iv" text NOT NULL,
	"ct" text NOT NULL,
	"device_id" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "records_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"device_label" text,
	"created_at" bigint NOT NULL,
	"last_seen" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "storage_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" bigint,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"created_at" bigint NOT NULL,
	"dek_wrapped_kek" text,
	"dek_wrapped_recovery" text,
	"kdf_salt_a" text,
	"kdf_salt_b" text,
	"kdf_params" text
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "records_user_cursor_idx" ON "records" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "records_user_taken_idx" ON "records" USING btree ("user_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "storage_kv_expires_idx" ON "storage_kv" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");