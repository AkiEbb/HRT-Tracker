CREATE TABLE `credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret_ct` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `invite_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`created_by` text,
	`used_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`used_at` integer,
	FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `records` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`taken_at` integer NOT NULL,
	`rev` integer NOT NULL,
	`iv` text NOT NULL,
	`ct` text NOT NULL,
	`device_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `records_user_cursor_idx` ON `records` (`user_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `records_user_taken_idx` ON `records` (`user_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`device_label` text,
	`created_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `storage_kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `storage_kv_expires_idx` ON `storage_kv` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_verified_at` integer,
	`status` text DEFAULT 'incomplete' NOT NULL,
	`created_at` integer NOT NULL,
	`dek_wrapped_kek` text,
	`dek_wrapped_recovery` text,
	`kdf_salt_a` text,
	`kdf_salt_b` text,
	`kdf_params` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);