CREATE TABLE `job_slides` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`page_index` integer NOT NULL,
	`image_key` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_slides_page_idx` ON `job_slides` (`job_id`,`page_index`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `edited_title` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `edited_transcript` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `edited_pages` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `notes` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `highlights` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `trashed_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `insights` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `suggestions` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `insight_status` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `insight_error` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `insight_model` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `insight_lease` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `insight_lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `insight_revision` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `canonical_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `duplicate_of` text;--> statement-breakpoint
CREATE INDEX jobs_library_view_idx ON jobs(owner_id,trashed_at,duplicate_of,reviewed_at,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX jobs_canonical_idx ON jobs(owner_id,canonical_id) WHERE canonical_id IS NOT NULL AND duplicate_of IS NULL;
--> statement-breakpoint
CREATE INDEX jobs_insights_idx ON jobs(insight_status,insight_lease_expires_at);
--> statement-breakpoint
CREATE VIRTUAL TABLE jobs_fts USING fts5(title,creator,transcript,notes,tags,tokenize='trigram');
--> statement-breakpoint
INSERT INTO jobs_fts(rowid,title,creator,transcript,notes,tags) SELECT rowid,COALESCE(edited_title,title,''),COALESCE(creator,''),COALESCE(edited_transcript,transcript,''),notes,tags FROM jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_fts_insert AFTER INSERT ON jobs BEGIN
 INSERT INTO jobs_fts(rowid,title,creator,transcript,notes,tags) VALUES(new.rowid,COALESCE(new.edited_title,new.title,''),COALESCE(new.creator,''),COALESCE(new.edited_transcript,new.transcript,''),new.notes,new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER jobs_fts_delete AFTER DELETE ON jobs BEGIN
 DELETE FROM jobs_fts WHERE rowid=old.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER jobs_fts_update AFTER UPDATE OF title,edited_title,creator,transcript,edited_transcript,notes,tags ON jobs BEGIN
 DELETE FROM jobs_fts WHERE rowid=old.rowid;
 INSERT INTO jobs_fts(rowid,title,creator,transcript,notes,tags) VALUES(new.rowid,COALESCE(new.edited_title,new.title,''),COALESCE(new.creator,''),COALESCE(new.edited_transcript,new.transcript,''),new.notes,new.tags);
END;
