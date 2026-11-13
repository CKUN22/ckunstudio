-- Dedicated tables: do not modify the personal site's other data.
CREATE TABLE IF NOT EXISTS studio_users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL, salt TEXT NOT NULL, created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS studio_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES studio_users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_sessions_expiry ON studio_sessions(expires);
CREATE TABLE IF NOT EXISTS studio_items (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('task','bug','idea')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('todo','doing','done')),
  assignee TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
  due TEXT NOT NULL, version INTEGER NOT NULL, created TEXT NOT NULL,
  updated TEXT NOT NULL, author TEXT NOT NULL REFERENCES studio_users(id), mutation TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_items_updated ON studio_items(updated DESC);
CREATE TABLE IF NOT EXISTS studio_images (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES studio_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL, size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_images_item ON studio_images(item_id);
CREATE TABLE IF NOT EXISTS studio_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS studio_limits_expiry ON studio_limits(expires);
