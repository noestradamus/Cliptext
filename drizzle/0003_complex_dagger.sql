CREATE TABLE `job_frames` (
	`job_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`image_key` text,
	`width` integer,
	`height` integer,
	`kind` text DEFAULT 'first_frame' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_frames_lease_idx` ON `job_frames` (`status`,`lease_expires_at`);