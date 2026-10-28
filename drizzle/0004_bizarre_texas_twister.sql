ALTER TABLE `jobs` ADD `content_kind` text DEFAULT 'video' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `pages` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `ocr_engine` text;