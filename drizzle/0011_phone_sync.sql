CREATE TABLE phone_sync_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id=1),
  enabled INTEGER DEFAULT 0 NOT NULL,
  port INTEGER DEFAULT 47322 NOT NULL,
  addresses TEXT DEFAULT '[]' NOT NULL
);
INSERT INTO phone_sync_settings(id) VALUES(1);

CREATE TABLE phone_sync_devices (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '' NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paired_at INTEGER,
  last_seen INTEGER,
  revoked_at INTEGER
);

CREATE TABLE phone_sync_receipts (
  device_id TEXT NOT NULL REFERENCES phone_sync_devices(id),
  request_id TEXT NOT NULL,
  request_url TEXT NOT NULL,
  job_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(device_id,request_id)
);

-- Keep tombstones after permanent deletion. A phone can be offline indefinitely.
CREATE TABLE phone_sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  deleted INTEGER NOT NULL
);
CREATE INDEX phone_sync_changes_owner_seq ON phone_sync_changes(owner_id,seq);

CREATE TRIGGER phone_sync_jobs_insert AFTER INSERT ON jobs BEGIN
  INSERT INTO phone_sync_changes(owner_id,job_id,deleted)
  VALUES(NEW.owner_id,NEW.id,CASE WHEN NEW.trashed_at IS NOT NULL OR NEW.duplicate_of IS NOT NULL THEN 1 ELSE 0 END);
END;
CREATE TRIGGER phone_sync_jobs_update AFTER UPDATE ON jobs BEGIN
  INSERT INTO phone_sync_changes(owner_id,job_id,deleted)
  SELECT OLD.owner_id,OLD.id,1 WHERE OLD.owner_id<>NEW.owner_id;
  INSERT INTO phone_sync_changes(owner_id,job_id,deleted)
  VALUES(NEW.owner_id,NEW.id,CASE WHEN NEW.trashed_at IS NOT NULL OR NEW.duplicate_of IS NOT NULL THEN 1 ELSE 0 END);
END;
CREATE TRIGGER phone_sync_jobs_delete AFTER DELETE ON jobs BEGIN
  INSERT INTO phone_sync_changes(owner_id,job_id,deleted) VALUES(OLD.owner_id,OLD.id,1);
END;

-- Existing libraries participate in the first cursor=0 synchronization too.
INSERT INTO phone_sync_changes(owner_id,job_id,deleted)
SELECT owner_id,id,CASE WHEN trashed_at IS NOT NULL OR duplicate_of IS NOT NULL THEN 1 ELSE 0 END
FROM jobs ORDER BY created_at,id;
