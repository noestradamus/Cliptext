CREATE TABLE web_companion_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  enabled INTEGER DEFAULT 0 NOT NULL,
  origin TEXT,
  port INTEGER DEFAULT 47323 NOT NULL,
  library_id TEXT NOT NULL,
  auth_secret TEXT NOT NULL
);
INSERT INTO web_companion_settings(id,library_id,auth_secret)
VALUES(1,'lib_'||lower(hex(randomblob(16))),lower(hex(randomblob(32))));

CREATE TABLE web_companion_devices (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('browser','shortcut')),
  name TEXT NOT NULL,
  bootstrap_hash TEXT UNIQUE,
  token_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  paired_at INTEGER,
  last_seen INTEGER,
  revoked_at INTEGER
);
CREATE TABLE web_companion_receipts (
  device_id TEXT NOT NULL REFERENCES web_companion_devices(id),
  request_id TEXT NOT NULL,
  request_url TEXT NOT NULL,
  job_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(device_id,request_id)
);
