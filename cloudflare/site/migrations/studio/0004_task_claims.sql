ALTER TABLE studio_items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE studio_users ADD COLUMN color INTEGER NOT NULL DEFAULT 0;
UPDATE studio_users SET color=(SELECT COUNT(*) FROM studio_users previous WHERE previous.rowid<studio_users.rowid)%12;
