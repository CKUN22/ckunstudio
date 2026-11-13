import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(process.env.DATA_DIR || path.join(root, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(process.env.DATA_DIR || path.join(root, 'data'), 'studio.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,password TEXT NOT NULL,salt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,assignee TEXT NOT NULL,priority TEXT NOT NULL,due TEXT NOT NULL,version INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,author TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,type TEXT NOT NULL,bytes BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
const id = () => randomBytes(16).toString('hex');
const hashToken = token => createHash('sha256').update(token).digest('hex');
const send = (res, code, value, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = (value, max, required = false) => { if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, '字段内容为空或超过长度限制'); return value.trim(); };
const attempts = new Map();
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 12 * 1024 * 1024) fail(413, '请求过大，图片总大小请控制在 8MB 内'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail(400, '请求格式错误'); }
}
function cookie(token, clear = false) { return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 604800}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`; }
function userFor(req) {
  const token = /(?:^|;\s*)session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  return token && db.prepare('SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(hashToken(token), Date.now());
}
function readItem(itemId) { const item = db.prepare('SELECT * FROM items WHERE id=?').get(itemId); if (!item) fail(404, '记录不存在'); return { ...item, images: db.prepare('SELECT id FROM images WHERE item_id=?').all(itemId).map(x => `/api/images/${x.id}`) }; }
function validateItem(data) {
  if (!['task', 'bug', 'idea'].includes(data.kind) || !['todo', 'doing', 'done'].includes(data.status) || !['low', 'normal', 'high', 'urgent'].includes(data.priority)) fail(400, '类型或状态无效');
  const assignee = text(data.assignee, 80);
  if (assignee && !db.prepare('SELECT id FROM users WHERE id=?').get(assignee)) fail(400, '执行人不存在');
  const due = text(data.due, 10); if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)))) fail(400, '日期无效');
  return [data.kind, text(data.title, 160, true), text(data.body, 20000), data.status, assignee, data.priority, due];
}
function imageData(images = []) {
  if (!Array.isArray(images) || images.length > 5) fail(400, '最多添加 5 张图片');
  let total = 0;
  return images.map(src => {
    if (typeof src !== 'string') fail(400, '图片格式无效');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(src);
    if (!match) fail(400, '仅支持 PNG、JPEG 和 WebP 图片');
    const bytes = Buffer.from(match[2], 'base64'); total += bytes.length;
    const valid = match[1] === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid || total > 8 * 1024 * 1024) fail(400, '图片无效或总大小超过 8MB');
    return { type: match[1], bytes };
  });
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
    if (['POST','PUT','DELETE'].includes(req.method) && req.headers.origin && req.headers.origin !== `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`) fail(403, '请求来源无效');
    if (route === '/api/setup' && req.method === 'GET') return send(res, 200, { needsSetup: !db.prepare('SELECT id FROM users LIMIT 1').get() });
    if (route === '/api/setup' && req.method === 'POST') {
      const data = await body(req);
      if (db.prepare('SELECT id FROM users LIMIT 1').get()) fail(409, '团队已初始化，请使用邀请码注册');
      const name = text(data.name, 40, true), password = text(data.password, 200, true);
      if (password.length < 10) fail(400, '密码至少需要 10 个字符');
      const uid = id(), salt = id(), invite = randomBytes(12).toString('hex');
      db.exec('BEGIN IMMEDIATE');
      try { db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(uid,name,scryptSync(password,salt,64).toString('hex'),salt); db.prepare('INSERT INTO settings VALUES(?,?)').run('invite',invite); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; }
      const token = id(); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token),uid,Date.now()+604800000);
      return send(res,201,{ user: {id:uid,name}, invite },{'Set-Cookie':cookie(token)});
    }
    if (['/api/login','/api/register'].includes(route) && req.method === 'POST') {
      const key = req.socket.remoteAddress; const entry = attempts.get(key); if (entry && entry.until > Date.now() && entry.count >= 15) fail(429, '尝试次数过多，请 15 分钟后重试');
      attempts.set(key,{count:entry?.until > Date.now() ? entry.count+1 : 1,until:entry?.until > Date.now() ? entry.until : Date.now()+900000});
      const data = await body(req), name = text(data.name,40,true), password = text(data.password,200,true); let user;
      if (route === '/api/register') {
        if (data.invite !== db.prepare('SELECT value FROM settings WHERE key=?').get('invite')?.value) fail(403,'邀请码不正确');
        if (password.length < 10) fail(400,'密码至少需要 10 个字符');
        if (db.prepare('SELECT id FROM users WHERE name=?').get(name)) fail(409,'该账号名称已存在');
        const salt = id(); user = {id:id(),name}; db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(user.id,name,scryptSync(password,salt,64).toString('hex'),salt);
      } else {
        const found = db.prepare('SELECT * FROM users WHERE name=?').get(name);
        const digest = scryptSync(password,found?.salt || 'dummy',64);
        if (!found || !timingSafeEqual(digest,Buffer.from(found.password,'hex'))) fail(401,'账号或密码不正确');
        user = {id:found.id,name:found.name};
      }
      const token = id(); db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token),user.id,Date.now()+604800000);
      return send(res,200,{user},{'Set-Cookie':cookie(token)});
    }
    if (route.startsWith('/api/')) {
      const user = userFor(req); if (!user) fail(401,'请先登录');
      if (route === '/api/me') return send(res,200,{user,invite:db.prepare('SELECT value FROM settings WHERE key=?').get('invite')?.value});
      if (route === '/api/logout' && req.method === 'POST') { const token = /session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1]; if(token) db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(token)); return send(res,200,{ok:true},{'Set-Cookie':cookie('',true)}); }
      if (route === '/api/users') return send(res,200,db.prepare('SELECT id,name FROM users ORDER BY name').all());
      if (route === '/api/items' && req.method === 'GET') return send(res,200,db.prepare('SELECT * FROM items ORDER BY updated DESC').all().map(x=>({...x,imageCount:db.prepare('SELECT count(*) AS n FROM images WHERE item_id=?').get(x.id).n})));
      const imageRoute = /^\/api\/images\/([a-f0-9]+)$/.exec(route);
      if (imageRoute && req.method === 'GET') { const img = db.prepare('SELECT * FROM images WHERE id=?').get(imageRoute[1]); if (!img) fail(404,'图片不存在'); res.writeHead(200,{'Content-Type':img.type,'Cache-Control':'private, max-age=3600'}); return res.end(img.bytes); }
      const match = /^\/api\/items\/([a-f0-9]+)$/.exec(route);
      if (match && req.method === 'GET') return send(res,200,readItem(match[1]));
      if ((route === '/api/items' && req.method === 'POST') || (match && req.method === 'PUT')) {
        const data = await body(req), fields = validateItem(data), images = imageData(data.newImages), now = new Date().toISOString(), itemId = match?.[1] || id();
        const existing = match ? readItem(itemId) : null;
        if (existing && data.version !== existing.version) fail(409,'其他成员已更新这条记录，请重新打开后编辑');
        const keep = existing ? data.keepImages : [];
        if (!Array.isArray(keep) || keep.some(src=>!existing?.images.includes(src)) || keep.length+images.length>5) fail(400,'附件无效，最多 5 张图片');
        db.exec('BEGIN IMMEDIATE');
        try {
          if(existing) db.prepare('UPDATE items SET kind=?,title=?,body=?,status=?,assignee=?,priority=?,due=?,version=version+1,updated=? WHERE id=?').run(...fields,now,itemId);
          else db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(itemId,...fields,1,now,now,user.id);
          if(existing) for(const src of existing.images) if(!keep.includes(src)) db.prepare('DELETE FROM images WHERE id=?').run(src.split('/').pop());
          for(const img of images) db.prepare('INSERT INTO images VALUES(?,?,?,?)').run(id(),itemId,img.type,img.bytes);
          db.exec('COMMIT');
        } catch(e) { db.exec('ROLLBACK'); throw e; }
        return send(res,existing?200:201,readItem(itemId));
      }
      if (match && req.method === 'DELETE') { const data=await body(req), current=readItem(match[1]); if(data.version!==current.version) fail(409,'记录已被更新，请重新打开'); db.prepare('DELETE FROM items WHERE id=?').run(match[1]); return send(res,200,{ok:true}); }
      fail(404,'接口不存在');
    }
    if (req.method !== 'GET') fail(405,'不支持的请求');
    const files = {'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
    const file = files[route]; if (!file) fail(404,'页面不存在');
    res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-cache'}); res.end(readFileSync(path.join(root,'public',file[0])));
  } catch(error) { const expected = Number.isInteger(error.code) && error.code >= 400 && error.code <= 599; if(!res.headersSent) send(res,expected ? error.code : 500,{error:expected ? error.message : '服务暂时无法处理请求'}); if(!expected) console.error(error); }
});
server.listen(Number(process.env.PORT || 3210), process.env.HOST || '127.0.0.1', () => console.log(`Studio Flow: http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3210}`));
