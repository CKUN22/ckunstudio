-- Independent website administrators; no changes to studio users or saved analytics.
CREATE TABLE site_admins (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
 password TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 created TEXT NOT NULL
);
CREATE TABLE site_admin_sessions (
 token TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES site_admins(id) ON DELETE CASCADE,
 expires INTEGER NOT NULL
);
CREATE INDEX site_admin_sessions_expiry ON site_admin_sessions(expires);
CREATE TABLE site_admin_limits (
 key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL
);
