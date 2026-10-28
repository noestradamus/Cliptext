ALTER TABLE `jobs` ADD `generated_title` text;
--> statement-breakpoint
DROP TRIGGER jobs_fts_insert;
--> statement-breakpoint
DROP TRIGGER jobs_fts_update;
--> statement-breakpoint
CREATE TRIGGER jobs_fts_insert AFTER INSERT ON jobs BEGIN
 INSERT INTO jobs_fts(rowid,title,creator,transcript,notes,tags) VALUES(new.rowid,COALESCE(new.edited_title,new.generated_title,new.title,''),COALESCE(new.creator,''),COALESCE(new.edited_transcript,new.transcript,''),new.notes,new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER jobs_fts_update AFTER UPDATE OF title,edited_title,generated_title,creator,transcript,edited_transcript,notes,tags ON jobs BEGIN
 DELETE FROM jobs_fts WHERE rowid=old.rowid;
 INSERT INTO jobs_fts(rowid,title,creator,transcript,notes,tags) VALUES(new.rowid,COALESCE(new.edited_title,new.generated_title,new.title,''),COALESCE(new.creator,''),COALESCE(new.edited_transcript,new.transcript,''),new.notes,new.tags);
END;
--> statement-breakpoint
DELETE FROM jobs_fts;
--> statement-breakpoint
INSERT INTO jobs_fts(rowid,title,creator,transcript,notes,tags) SELECT rowid,COALESCE(edited_title,generated_title,title,''),COALESCE(creator,''),COALESCE(edited_transcript,transcript,''),notes,tags FROM jobs;
--> statement-breakpoint
-- Preserve existing summaries while requesting compact titles from the new worker.
-- Revoking old leases prevents an in-flight pre-upgrade result consuming this queue.
UPDATE jobs SET insight_status='queued',insight_lease=NULL,insight_lease_expires_at=NULL,insight_revision=NULL,insight_error=NULL
 WHERE status='completed' AND duplicate_of IS NULL AND generated_title IS NULL;
