CREATE TABLE `appearance_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`active_theme_id` text,
	FOREIGN KEY (`active_theme_id`) REFERENCES `appearance_themes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `appearance_themes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`accent` text NOT NULL,
	`background` text NOT NULL,
	`foreground` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appearance_themes_owner_name_idx` ON `appearance_themes` (`owner_id`,`name_key`);