CREATE TABLE `engine` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`active_job_id` text,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`title` text,
	`creator` text,
	`transcript` text,
	`segments` text,
	`language` text,
	`duration_seconds` real,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_owner_created_idx` ON `jobs` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_queue_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_owner_url_idx` ON `jobs` (`owner_id`,`url`);