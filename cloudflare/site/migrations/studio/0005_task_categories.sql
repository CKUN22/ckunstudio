ALTER TABLE studio_items ADD COLUMN category TEXT NOT NULL DEFAULT '' CHECK(category IN ('','角色','地图','物品','机制'));
UPDATE studio_items SET category=CASE
 WHEN title GLOB '主角动作-*' OR title GLOB '商人动作-*' OR title GLOB '木乃伊动作-*' OR title GLOB '单只猫动作-*' OR title GLOB '角色-*' THEN '角色'
 WHEN title GLOB '关卡-*' OR title GLOB '地图-*' OR title GLOB 'map[0-9]*' THEN '地图'
 WHEN title GLOB '道具-*' OR title GLOB '物品-*' THEN '物品'
 ELSE '机制' END,version=version+1 WHERE kind='task';
