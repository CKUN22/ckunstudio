ALTER TABLE studio_users ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
ALTER TABLE studio_users ADD COLUMN avatar_version TEXT NOT NULL DEFAULT '';
CREATE TABLE studio_avatars (
 user_id TEXT PRIMARY KEY REFERENCES studio_users(id) ON DELETE CASCADE,
 version TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('image/png','image/jpeg','image/webp')),
 size INTEGER NOT NULL CHECK(size>0 AND size<262144), data TEXT NOT NULL
);
-- Durable aggregates: deliberately no TTL, retention job or cascading dependency on accounts.
CREATE TABLE site_metrics (
 day TEXT NOT NULL, scope TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL,
 requests INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
 bots INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
 duration_ms INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(day,scope,dimension,value)
);
CREATE TABLE site_visitors (
 day TEXT NOT NULL, scope TEXT NOT NULL, visitor TEXT NOT NULL,
 PRIMARY KEY(day,scope,visitor)
);
CREATE TABLE site_security (
 day TEXT NOT NULL, scope TEXT NOT NULL, reason TEXT NOT NULL, path TEXT NOT NULL,
 status INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1, last_seen TEXT NOT NULL,
 PRIMARY KEY(day,scope,reason,path,status)
);
CREATE TABLE site_telemetry_failures (
 day TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE site_verification_uses (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
