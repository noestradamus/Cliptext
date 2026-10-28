ALTER TABLE `jobs` ADD `slide_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `slide_lease` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `slide_lease_expires_at` text;