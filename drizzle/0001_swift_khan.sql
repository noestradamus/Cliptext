CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`key_fingerprint` text NOT NULL,
	`pair_nonce` text NOT NULL,
	`sealed_capsule` text,
	`capsule_expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_idx` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_pair_nonce_idx` ON `devices` (`pair_nonce`);