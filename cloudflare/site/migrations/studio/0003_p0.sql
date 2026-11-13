-- P0: existing earliest account becomes captain; historical accounts remain intact.
ALTER TABLE studio_users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE studio_users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
UPDATE studio_users SET role='captain' WHERE id=(SELECT id FROM studio_users ORDER BY created,rowid LIMIT 1);
CREATE UNIQUE INDEX studio_one_captain ON studio_users(role) WHERE role='captain';
CREATE TABLE studio_invites(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,max_uses INTEGER NOT NULL,uses INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,author TEXT NOT NULL);
-- Retire the legacy perpetual invitation on upgrade.
DELETE FROM studio_settings WHERE key='invite';
ALTER TABLE studio_items ADD COLUMN eta TEXT NOT NULL DEFAULT '';
ALTER TABLE studio_items ADD COLUMN progress TEXT NOT NULL DEFAULT '';
ALTER TABLE studio_items ADD COLUMN remaining TEXT NOT NULL DEFAULT '';
ALTER TABLE studio_items ADD COLUMN eta_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE studio_items ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT '';
-- Original status constraint is retained: blocking is represented by blocked_reason and exposed as blocked.
CREATE TABLE studio_dependencies(item_id TEXT NOT NULL REFERENCES studio_items(id) ON DELETE CASCADE,predecessor TEXT NOT NULL REFERENCES studio_items(id) ON DELETE CASCADE,PRIMARY KEY(item_id,predecessor),CHECK(item_id<>predecessor));
CREATE TABLE studio_follows(item_id TEXT NOT NULL REFERENCES studio_items(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES studio_users(id),PRIMARY KEY(item_id,user_id));
CREATE TABLE studio_notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES studio_users(id),item_id TEXT NOT NULL,title TEXT NOT NULL,event_key TEXT NOT NULL,created TEXT NOT NULL,read_at TEXT NOT NULL DEFAULT '',UNIQUE(user_id,event_key));
CREATE INDEX studio_notifications_user ON studio_notifications(user_id,created);
CREATE TABLE studio_activity(id TEXT PRIMARY KEY,actor TEXT NOT NULL,event TEXT NOT NULL,target TEXT NOT NULL,created TEXT NOT NULL);
CREATE TRIGGER studio_dependency_cycle BEFORE INSERT ON studio_dependencies BEGIN
 SELECT RAISE(ABORT,'dependency cycle') WHERE EXISTS(
 WITH RECURSIVE chain(id) AS (SELECT NEW.predecessor UNION SELECT d.predecessor FROM studio_dependencies d JOIN chain c ON d.item_id=c.id)
 SELECT 1 FROM chain WHERE id=NEW.item_id);
END;
