-- Keep the already-applied prototype migration immutable. Old prototype pairing
-- capabilities cannot be upgraded safely, so revoke them without touching jobs.
ALTER TABLE phone_sync_devices ADD COLUMN bootstrap_hash TEXT;
CREATE UNIQUE INDEX phone_sync_devices_bootstrap ON phone_sync_devices(bootstrap_hash);
UPDATE phone_sync_devices SET revoked_at=COALESCE(revoked_at,CAST(strftime('%s','now') AS INTEGER)*1000);

DROP TRIGGER phone_sync_jobs_update;
CREATE TRIGGER phone_sync_jobs_update AFTER UPDATE ON jobs BEGIN
  INSERT INTO phone_sync_changes(owner_id,job_id,deleted)
  SELECT OLD.owner_id,OLD.id,1 WHERE OLD.owner_id<>NEW.owner_id;
  INSERT INTO phone_sync_changes(owner_id,job_id,deleted)
  VALUES(NEW.owner_id,NEW.id,CASE WHEN NEW.trashed_at IS NOT NULL OR NEW.duplicate_of IS NOT NULL THEN 1 ELSE 0 END);
END;
