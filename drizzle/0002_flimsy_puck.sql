CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_owner_name_idx` ON `collections` (`owner_id`,`name`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `platform` text DEFAULT 'tiktok' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `favorite` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `collection_id` text REFERENCES collections(id);