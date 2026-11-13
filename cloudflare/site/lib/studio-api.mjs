const BASE = '/ckunstudio/api';
const COOKIE = 'ckunstudio_session';
const encoder = new TextEncoder();
const security = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
};
function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...security, 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
const fail = (code, message) => { throw Object.assign(new Error(message), { status: code }); };
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
const sha = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, '字段内容为空或超过长度限制');
  return value.trim();
};
function secretEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = encoder.encode(a), bb = encoder.encode(b); let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}
async function passwordHash(password, salt, pepper) {
  const hmacKey = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const material = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(password));
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100000 }, key, 256));
}
async function readBody(request) {
  if (!request.body) return {};
  const reader = request.body.getReader(); let length = 0; const chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 12 * 1024 * 1024) { await reader.cancel(); fail(413, '请求过大，图片总大小请控制在 8MB 内'); } chunks.push(value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const data = JSON.parse(new TextDecoder().decode(bytes) || '{}'); if (!data || Array.isArray(data) || typeof data !== 'object') fail(400, '请求格式错误'); return data; } catch { fail(400, '请求格式错误'); }
}
function sessionToken(request) { return new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{48})`).exec(request.headers.get('Cookie') || '')?.[1]; }
function cookie(request, token = '') { return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/ckunstudio; Max-Age=${token ? 604800 : 0}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
const selectItem = 'SELECT id,kind,title,body,status,assignee,priority,due,version,created,updated,author FROM studio_items';
async function getItem(db, id) {
  const item = await db.prepare(`${selectItem} WHERE id=?`).bind(id).first();
  if (!item) fail(404, '记录不存在');
  const images = (await db.prepare('SELECT id,type,size FROM studio_images WHERE item_id=? ORDER BY id').bind(id).all()).results;
  return { ...item, images: images.map(x => `${BASE}/images/${x.id}`), imageMeta: images };
}
function publicItem(item) { const { imageMeta, ...rest } = item; return rest; }
async function fieldsFor(db, data) {
  if (!['task', 'bug', 'idea'].includes(data.kind) || !['todo', 'doing', 'done'].includes(data.status) || !['low', 'normal', 'high', 'urgent'].includes(data.priority)) fail(400, '类型或状态无效');
  const assignee = text(data.assignee, 80);
  if (assignee && !await db.prepare('SELECT id FROM studio_users WHERE id=?').bind(assignee).first()) fail(400, '执行人不存在');
  const due = text(data.due, 10);
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)) fail(400, '日期无效');
  return [data.kind, text(data.title, 160, true), text(data.body, 20000), data.status, assignee, data.priority, due];
}
function parseImages(sources = []) {
  if (!Array.isArray(sources) || sources.length > 5) fail(400, '最多添加 5 张图片');
  let total = 0;
  return sources.map(src => {
    if (typeof src !== 'string') fail(400, '图片格式无效');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(src);
    if (!match) fail(400, '仅支持 PNG、JPEG 和 WebP');
    let decoded; try { decoded = atob(match[2]); } catch { fail(400, '图片编码无效'); }
    const bytes = Uint8Array.from(decoded, x => x.charCodeAt(0)); total += bytes.length;
    const valid = match[1] === 'image/png' ? [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b) : match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : decoded.slice(0,4) === 'RIFF' && decoded.slice(8,12) === 'WEBP';
    if (!valid || bytes.length > 512 * 1024 || total > 5 * 512 * 1024) fail(400, '免费测试版每张图片最多 512KB，请压缩后上传');
    return { id: random(), type: match[1], bytes, data: match[2] };
  });
}
async function rateLimit(db, request, route) {
  const now = Date.now(), window = Math.floor(now / 900000);
  const key = await sha(`${request.headers.get('CF-Connecting-IP') || 'local'}:${route}:${window}`);
  const row = await db.prepare('INSERT INTO studio_limits(key,attempts,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(key, (window + 1) * 900000).first();
  await db.prepare('DELETE FROM studio_limits WHERE expires<?').bind(now).run();
  if (row.attempts > 20) fail(429, '尝试次数过多，请 15 分钟后重试');
}
async function loginResponse(db, request, user, extra = {}, status = 200) {
  const token = random();
  await db.batch([
    db.prepare('DELETE FROM studio_sessions WHERE expires<?').bind(Date.now()),
    db.prepare('INSERT INTO studio_sessions VALUES(?,?,?)').bind(await sha(token), user.id, Date.now() + 604800000)
  ]);
  return json(status, { user, ...extra }, { 'Set-Cookie': cookie(request, token) });
}

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url), route = url.pathname.slice(BASE.length).replace(/\/$/, '') || '/';
    if (!url.pathname.startsWith(BASE + '/')) fail(404, '接口不存在');
    if (!env.STUDIO_DB || !env.STUDIO_AUTH_SECRET || env.STUDIO_AUTH_SECRET.length < 32) fail(503, '协作服务尚未配置完成，请联系站点管理员绑定数据库和认证密钥');
    const db = env.STUDIO_DB.withSession ? env.STUDIO_DB.withSession('first-primary') : env.STUDIO_DB;
    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) fail(403, '请求来源无效');
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, '请使用 JSON 请求');
    }
    if (route === '/setup' && request.method === 'GET') {
      return json(200, { needsSetup: !await db.prepare('SELECT id FROM studio_users LIMIT 1').first(), setupKeyRequired: true });
    }
    if (route === '/setup' && request.method === 'POST') {
      await rateLimit(db, request, route);
      if (await db.prepare('SELECT id FROM studio_users LIMIT 1').first()) fail(409, '团队已初始化，请使用邀请码加入');
      const data = await readBody(request);
      if (!env.STUDIO_SETUP_KEY || env.STUDIO_SETUP_KEY.length < 24) fail(503, '管理员尚未设置团队初始化密钥');
      if (!secretEqual(data.setupKey, env.STUDIO_SETUP_KEY)) fail(403, '初始化密钥不正确');
      const name = text(data.name, 40, true), password = text(data.password, 200, true);
      if (password.length < 10) fail(400, '密码至少需要 10 个字符');
      const uid = random(), salt = random(), invite = random(), mutation = random();
      const digest = await passwordHash(password, salt, env.STUDIO_AUTH_SECRET);
      // The unique setup marker and both inserts commit atomically, even across isolates.
      try {
        await db.batch([
          db.prepare('INSERT INTO studio_settings(key,value) VALUES(?,?)').bind('initialized', mutation),
          db.prepare('INSERT INTO studio_users VALUES(?,?,?,?,?)').bind(uid, name, digest, salt, new Date().toISOString()),
          db.prepare('INSERT INTO studio_settings(key,value) VALUES(?,?)').bind('invite', invite)
        ]);
      } catch (error) { if (await db.prepare('SELECT value FROM studio_settings WHERE key=?').bind('initialized').first()) fail(409, '团队已经初始化'); throw error; }
      return loginResponse(db, request, { id: uid, name }, { invite }, 201);
    }
    if (['/login', '/register'].includes(route) && request.method === 'POST') {
      await rateLimit(db, request, route);
      const data = await readBody(request), name = text(data.name, 40, true), password = text(data.password, 200, true);
      let user;
      if (route === '/register') {
        const invite = await db.prepare('SELECT value FROM studio_settings WHERE key=?').bind('invite').first();
        if (!invite || !secretEqual(data.invite, invite.value)) fail(403, '邀请码不正确');
        if (password.length < 10) fail(400, '密码至少需要 10 个字符');
        const salt = random(), digest = await passwordHash(password, salt, env.STUDIO_AUTH_SECRET); user = { id: random(), name };
        try { await db.prepare('INSERT INTO studio_users VALUES(?,?,?,?,?)').bind(user.id, name, digest, salt, new Date().toISOString()).run(); }
        catch (error) { if (await db.prepare('SELECT id FROM studio_users WHERE name=?').bind(name).first()) fail(409, '该账号名称已存在'); throw error; }
      } else {
        const found = await db.prepare('SELECT * FROM studio_users WHERE name=?').bind(name).first();
        const digest = await passwordHash(password, found?.salt || 'unknown-user-dummy-salt', env.STUDIO_AUTH_SECRET);
        if (!found || !secretEqual(digest, found.password)) fail(401, '账号或密码不正确');
        user = { id: found.id, name: found.name };
      }
      return loginResponse(db, request, user);
    }
    const token = sessionToken(request);
    const user = token && await db.prepare('SELECT u.id,u.name FROM studio_sessions s JOIN studio_users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').bind(await sha(token), Date.now()).first();
    if (!user) fail(401, '请先登录');
    if (route === '/me' && request.method === 'GET') return json(200, { user, invite: (await db.prepare('SELECT value FROM studio_settings WHERE key=?').bind('invite').first())?.value });
    if (route === '/logout' && request.method === 'POST') { await db.prepare('DELETE FROM studio_sessions WHERE token=?').bind(await sha(token)).run(); return json(200, { ok: true }, { 'Set-Cookie': cookie(request) }); }
    if (route === '/users' && request.method === 'GET') return json(200, (await db.prepare('SELECT id,name FROM studio_users ORDER BY name').all()).results);
    if (route === '/items' && request.method === 'GET') return json(200, (await db.prepare('SELECT i.id,i.kind,i.title,i.body,i.status,i.assignee,i.priority,i.due,i.version,i.created,i.updated,i.author,(SELECT COUNT(*) FROM studio_images m WHERE m.item_id=i.id) AS imageCount FROM studio_items i ORDER BY i.updated DESC').all()).results);
    const imgRoute = /^\/images\/([a-f0-9]{48})$/.exec(route);
    if (imgRoute && request.method === 'GET') {
      const image = await db.prepare('SELECT i.type,d.data FROM studio_images i JOIN studio_image_data d ON d.id=i.id WHERE i.id=?').bind(imgRoute[1]).first();
      if (!image) fail(404, '图片不存在');
      return new Response(Uint8Array.from(atob(image.data), c => c.charCodeAt(0)), { headers: { ...security, 'Content-Type': image.type, 'Content-Disposition': 'inline' } });
    }
    const match = /^\/items\/([a-f0-9]{48})$/.exec(route);
    if (match && request.method === 'GET') return json(200, publicItem(await getItem(db, match[1])));
    if ((route === '/items' && request.method === 'POST') || (match && request.method === 'PUT')) {
      const data = await readBody(request), fields = await fieldsFor(db, data), images = parseImages(data.newImages);
      const itemId = match?.[1] || random(), existing = match ? await getItem(db, itemId) : null;
      if (existing && data.version !== existing.version) fail(409, '其他成员已更新这条记录，请重新打开后编辑');
      const keep = existing ? data.keepImages : [];
      if (!Array.isArray(keep) || new Set(keep).size !== keep.length || keep.some(src => !existing?.images.includes(src)) || keep.length + images.length > 5) fail(400, '附件无效，最多添加 5 张图片');
      const keepMeta = existing?.imageMeta.filter(x => keep.includes(`${BASE}/images/${x.id}`)) || [];
      if (keepMeta.reduce((n, x) => n + x.size, 0) + images.reduce((n, x) => n + x.bytes.length, 0) > 5 * 512 * 1024) fail(400, '所有图片总大小不能超过 2.5MB');
      const now = new Date().toISOString(), mutation = random();
      const removed = existing?.imageMeta.filter(x => !keep.includes(`${BASE}/images/${x.id}`)) || [];
      const statements = [existing ? db.prepare('UPDATE studio_items SET kind=?,title=?,body=?,status=?,assignee=?,priority=?,due=?,version=version+1,updated=?,mutation=? WHERE id=? AND version=? RETURNING id').bind(...fields, now, mutation, itemId, data.version) : db.prepare('INSERT INTO studio_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id').bind(itemId, ...fields, 1, now, now, user.id, mutation)];
      for (const image of removed) statements.push(db.prepare('DELETE FROM studio_images WHERE id=? AND EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(image.id, itemId, mutation));
      for (const image of images) {
        statements.push(db.prepare('INSERT INTO studio_images(id,item_id,type,size) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(image.id, itemId, image.type, image.bytes.length, itemId, mutation));
        statements.push(db.prepare('INSERT INTO studio_image_data(id,data) SELECT ?,? WHERE EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(image.id, image.data, itemId, mutation));
      }
      const result = await db.batch(statements);
      if (!result[0].results.length) fail(409, '其他成员已更新这条记录，请重新打开后编辑');
      return json(existing ? 200 : 201, publicItem(await getItem(db, itemId)));
    }
    if (match && request.method === 'DELETE') {
      const data = await readBody(request), existing = await getItem(db, match[1]);
      if (!Number.isInteger(data.version)) fail(400, '版本号无效');
      if (existing.version !== data.version) fail(409, '记录已被更新，请重新打开后删除');
      const result = await db.prepare('DELETE FROM studio_items WHERE id=? AND version=? RETURNING id').bind(match[1], data.version).all();
      if (!result.results.length) fail(409, '记录已被更新，请重新打开后删除');
      return json(200, { ok: true });
    }
    fail(404, '接口不存在');
  } catch (error) {
    if (!Number.isInteger(error.status)) console.error('Studio API error', error);
    return json(Number.isInteger(error.status) ? error.status : 500, { error: Number.isInteger(error.status) ? error.message : '协作服务暂时无法处理请求，请检查数据库迁移和服务配置' });
  }
}
