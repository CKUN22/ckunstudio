import {verificationSettings,makeChallenge,solveChallenge,hasClearance} from './verification.mjs';
import { TASK_CATEGORIES, inferTaskCategory, MAX_TASK_TAGS, normalizeTags, tagsFor } from './task-catalog.mjs';
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
const inviteCode = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2,'0')).join('');
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
function sessionToken(request) { const name=new URL(request.url).pathname.startsWith('/api/')?'session':COOKIE;const value=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);return /^[a-f0-9]{32,48}$/.test(value||'')?value:undefined; }
function cookie(request, token = '') { return `${new URL(request.url).pathname.startsWith('/api/') ? 'session' : COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${new URL(request.url).pathname.startsWith('/api/')?'/':'/ckunstudio'}; Max-Age=${token ? 604800 : 0}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
const selectItem = `SELECT i.*,(SELECT COALESCE(NULLIF(nickname,''),name) FROM studio_users WHERE id=i.author) AS authorName,(SELECT COALESCE(NULLIF(nickname,''),name) FROM studio_users WHERE id=i.assignee) AS assigneeName,(SELECT color FROM studio_users WHERE id=i.assignee) AS assigneeColor FROM studio_items i`;
async function getItem(db, id) {
  const item = await db.prepare(`${selectItem} WHERE i.id=?`).bind(id).first();
  if (!item) fail(404, '记录不存在');
  const images = (await db.prepare('SELECT id,type,size FROM studio_images WHERE item_id=? ORDER BY id').bind(id).all()).results;
  return { ...item, tags:normalizeTags(item.tags), status:item.blocked_reason ? 'blocked' : item.status, dependencies:(await db.prepare('SELECT predecessor FROM studio_dependencies WHERE item_id=?').bind(id).all()).results.map(x=>x.predecessor), images: images.map(x => `${BASE}/images/${x.id}`), imageMeta: images };
}
function publicItem(item) { const { imageMeta, ...rest } = item; return rest; }
async function fieldsFor(db, data, existing) {
  if(!existing && ['task','bug','idea'].includes(data.kind)){data.status??='todo';data.assignee??='';data.priority??='normal';data.due??='';data.body??='';}
  if (!['task', 'bug', 'idea'].includes(data.kind) || !['todo', 'doing', 'done', 'blocked'].includes(data.status) || !['low', 'normal', 'high', 'urgent'].includes(data.priority)) fail(400, '类型或状态无效');
  const assignee = text(data.assignee, 80);
  if(['task','bug'].includes(existing?.kind)&&assignee!==existing.assignee)fail(403,'请通过认领或取消认领操作修改执行人');
  if (assignee && assignee!==existing?.assignee && !await db.prepare('SELECT id FROM studio_users WHERE id=? AND active=1').bind(assignee).first()) fail(400, '执行人不存在');
  const due = text(data.due, 10);
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)) fail(400, '日期无效');
  return [data.kind, text(data.title, 160, true), text(data.body, 20000), data.status==='blocked'?'todo':data.status, assignee, data.priority, due];
}
function parseImages(sources = [], local = false) {
  if (!Array.isArray(sources) || sources.length > 5) fail(400, '最多添加 5 张图片');
  let total = 0;
  return sources.map(src => {
    if (typeof src !== 'string') fail(400, '图片格式无效');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(src);
    if (!match) fail(400, '仅支持 PNG、JPEG 和 WebP');
    let decoded; try { decoded = atob(match[2]); } catch { fail(400, '图片编码无效'); }
    const bytes = Uint8Array.from(decoded, x => x.charCodeAt(0)); total += bytes.length;
    const valid = match[1] === 'image/png' ? [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b) : match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : decoded.slice(0,4) === 'RIFF' && decoded.slice(8,12) === 'WEBP';
    if (!valid || (local ? total > 8 * 1024 * 1024 : bytes.length > 512 * 1024 || total > 5 * 512 * 1024)) fail(400, '免费测试版每张图片最多 512KB，请压缩后上传');
    return { id: random(), type: match[1], bytes, data: match[2] };
  });
}
function validateAvatarDimensions(image) {
 const b=image.bytes,view=new DataView(b.buffer,b.byteOffset,b.byteLength);let width=0,height=0;
 if(image.type==='image/png'&&b.length>=24){width=view.getUint32(16);height=view.getUint32(20);}
 else if(image.type==='image/webp'&&b.length>=30){
  const chunk=String.fromCharCode(...b.slice(12,16));
  if(chunk==='VP8X'){width=1+b[24]+(b[25]<<8)+(b[26]<<16);height=1+b[27]+(b[28]<<8)+(b[29]<<16);}
  else if(chunk==='VP8L'&&b[20]===47){width=1+b[21]+((b[22]&63)<<8);height=1+(b[22]>>6)+(b[23]<<2)+((b[24]&15)<<10);}
  else if(chunk==='VP8 '&&b[23]===157&&b[24]===1&&b[25]===42){width=view.getUint16(26,true)&16383;height=view.getUint16(28,true)&16383;}
 }
 else if(image.type==='image/jpeg'){
  for(let at=2;at+8<b.length;){if(b[at]!==255)break;const marker=b[at+1];if(marker===217||marker===218)break;const length=view.getUint16(at+2);if(length<2||at+2+length>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=view.getUint16(at+5);width=view.getUint16(at+7);break;}at+=2+length;}
 }
 if(width<1||height<1||width>1024||height>1024)fail(400,'头像尺寸无效，请通过用户信息页重新压缩上传');
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
    const url = new URL(request.url), base=env.LOCAL_MODE?'/api':BASE, route = url.pathname.slice(base.length).replace(/\/$/, '') || '/';
    if (!url.pathname.startsWith(base + '/')) fail(404, '接口不存在');
    if (!env.STUDIO_DB || !env.STUDIO_AUTH_SECRET || env.STUDIO_AUTH_SECRET.length < 32) fail(503, '协作服务尚未配置完成，请联系站点管理员绑定数据库和认证密钥');
    const db = env.STUDIO_DB.withSession ? env.STUDIO_DB.withSession('first-primary') : env.STUDIO_DB;
    if (!['GET','HEAD','POST','PUT','DELETE'].includes(request.method)) fail(405,'不支持的请求方法');
    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403,'请求来源无效');
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) fail(403, '请求来源无效');
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, '请使用 JSON 请求');
    }
    if(route==='/verification'){
      await rateLimit(db,request,'verification:'+request.method);
      if(request.method==='GET')return json(200,await makeChallenge(db,env,request));
      if(request.method==='POST')return json(200,{ok:true},{'Set-Cookie':await solveChallenge(db,env,request,await readBody(request))});
    }
    if(['/setup','/login','/register'].includes(route)&&request.method==='POST'){
      const protection=await verificationSettings(db,env);
      if(protection.mode!=='off'&&!await hasClearance(env,request))fail(403,'请先完成网站访问验证，再登录或注册');
    }
    if(route.startsWith('/admin/'))fail(404,'接口已移至独立的网站后台');
    if (route === '/setup' && request.method === 'GET') {
      return json(200, { needsSetup: !await db.prepare('SELECT id FROM studio_users LIMIT 1').first(), setupKeyRequired: !env.LOCAL_MODE });
    }
    if (route === '/setup' && request.method === 'POST') {
      await rateLimit(db, request, route);
      if (await db.prepare('SELECT id FROM studio_users LIMIT 1').first()) fail(409, '团队已初始化，请使用邀请码加入');
      const data = await readBody(request);
      if (!env.LOCAL_MODE && (!env.STUDIO_SETUP_KEY || env.STUDIO_SETUP_KEY.length < (env.PRIVATE_TEST_MODE?8:24))) fail(503, '管理员尚未设置团队初始化密钥');
      if (!env.LOCAL_MODE && !secretEqual(data.setupKey, env.STUDIO_SETUP_KEY)) fail(403, '初始化密钥不正确');
      const name = text(data.name, 40, true), password = text(data.password, 200, true);
      if (password.length < 10) fail(400, '密码至少需要 10 个字符');
      const uid = random(), salt = random(), invite = inviteCode(), mutation = random();
      const digest = await passwordHash(password, salt, env.STUDIO_AUTH_SECRET);
      // The unique setup marker and both inserts commit atomically, even across isolates.
      try {
        await db.batch([
          db.prepare('INSERT INTO studio_settings(key,value) VALUES(?,?)').bind('initialized', mutation),
          db.prepare("INSERT INTO studio_users(id,name,password,salt,created,role,active) VALUES(?,?,?,?,?,'captain',1)").bind(uid, name, digest, salt, new Date().toISOString()),
          db.prepare('INSERT INTO studio_invites(id,code,expires,max_uses,created,author) VALUES(?,?,?,?,?,?)').bind(random(),invite,Date.now()+7*86400000,10,new Date().toISOString(),uid)
        ]);
      } catch (error) { if (await db.prepare('SELECT value FROM studio_settings WHERE key=?').bind('initialized').first()) fail(409, '团队已经初始化'); throw error; }
      return loginResponse(db, request, { id: uid, name, role:'captain' }, { invite }, 201);
    }
    if (['/login', '/register'].includes(route) && request.method === 'POST') {
      await rateLimit(db, request, route);
      const data = await readBody(request), name = text(data.name, 40, true), password = text(data.password, 200, true);
      let user;
      if (route === '/register') {
        const invite = await db.prepare('SELECT * FROM studio_invites WHERE code=?').bind(typeof data.invite==='string'?data.invite:'').first();
        if (!invite) fail(403,'邀请无效');
        if(invite.revoked) fail(403,'邀请已撤销');
        if(invite.expires<=Date.now()) fail(403,'邀请已过期');
        if(invite.uses>=invite.max_uses) fail(403,'邀请使用次数已用尽');
        if (password.length < 10) fail(400, '密码至少需要 10 个字符');
        const salt = random(), digest = await passwordHash(password, salt, env.STUDIO_AUTH_SECRET); user = { id: random(), name };
        try { const result=await db.batch([
          db.prepare("INSERT INTO studio_users(id,name,password,salt,created,color) SELECT ?,?,?,?,?,(SELECT p.color FROM (SELECT value AS color FROM json_each('[0,1,2,3,4,5,6,7,8,9,10,11]')) p LEFT JOIN studio_users u ON u.color=p.color AND u.active=1 GROUP BY p.color ORDER BY COUNT(u.id),p.color LIMIT 1) WHERE EXISTS(SELECT 1 FROM studio_invites WHERE id=? AND revoked=0 AND expires>? AND uses<max_uses) RETURNING id").bind(user.id,name,digest,salt,new Date().toISOString(),invite.id,Date.now()),
          db.prepare('UPDATE studio_invites SET uses=uses+1 WHERE id=? AND EXISTS(SELECT 1 FROM studio_users WHERE id=?)').bind(invite.id,user.id),
          db.prepare('INSERT INTO studio_activity SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM studio_users WHERE id=?)').bind(random(),user.id,'join',user.id,new Date().toISOString(),user.id)
        ]); if(!result[0].results.length) fail(403,'邀请已失效或用尽'); user.role='member'; }
        catch (error) { if (await db.prepare('SELECT id FROM studio_users WHERE name=?').bind(name).first()) fail(409, '该账号名称已存在'); throw error; }
      } else {
        const found = await db.prepare('SELECT * FROM studio_users WHERE name=?').bind(name).first();
        const digest = await passwordHash(password, found?.salt || 'unknown-user-dummy-salt', env.STUDIO_AUTH_SECRET);
        if (!found || !(env.LOCAL_VERIFY && found.password.length===128 ? env.LOCAL_VERIFY(password,found) : secretEqual(digest, found.password))) fail(401, '账号或密码不正确');
        if(!found.active) fail(403,'你已被移出团队，请联系队长'); user = { id: found.id, name: found.name,role:found.role };
      }
      return loginResponse(db, request, user);
    }
    const token = sessionToken(request);
    const user = token && await db.prepare(`SELECT u.id,COALESCE(NULLIF(u.nickname,''),u.name) AS name,u.name AS loginName,u.nickname,u.avatar_version,u.role,u.color FROM studio_sessions s JOIN studio_users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1`).bind(await sha(token), Date.now()).first();
    if (!user) fail(401, '登录已失效或你已被移出团队，请重新登录或联系队长');
    if (route === '/me' && request.method === 'PUT') {
      await rateLimit(db,request,'profile:'+user.id);
      const data=await readBody(request),nickname=text(data.nickname,40,true);
      let image;
      if(data.avatar!==undefined&&data.avatar!==null){
        image=parseImages([data.avatar])[0];
        if(image.bytes.length>=256*1024)fail(400,'头像必须小于 256KB');
        validateAvatarDimensions(image);
        image.version=await sha(image.data);
      }
      const statements=[db.prepare('UPDATE studio_users SET nickname=? WHERE id=?').bind(nickname,user.id)];
      if(image){statements.push(db.prepare('INSERT INTO studio_avatars(user_id,version,type,size,data) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,type=excluded.type,size=excluded.size,data=excluded.data').bind(user.id,image.version,image.type,image.bytes.length,image.data),db.prepare('UPDATE studio_users SET avatar_version=? WHERE id=?').bind(image.version,user.id));}
      if(data.avatar===null)statements.push(db.prepare('DELETE FROM studio_avatars WHERE user_id=?').bind(user.id),db.prepare("UPDATE studio_users SET avatar_version='' WHERE id=?").bind(user.id));
      statements.push(activity(db,user,'profile-update',user.id));
      await db.batch(statements);
      return json(200,{user:{...user,name:nickname,nickname,avatar_version:image?image.version:data.avatar===null?'':user.avatar_version}});
    }
    const avatarMatch=/^\/avatars\/([a-f0-9]{32,48})$/.exec(route);
    if(avatarMatch&&request.method==='GET'){
      const image=await db.prepare('SELECT a.* FROM studio_avatars a JOIN studio_users u ON u.id=a.user_id WHERE a.user_id=? AND u.active=1').bind(avatarMatch[1]).first();
      if(!image||url.searchParams.get('v')!==image.version)fail(404,'头像版本不存在');
      const etag='"'+image.version+'"',headers={...security,'Content-Type':image.type,'Cache-Control':'private, max-age=31536000, immutable','ETag':etag,'Vary':'Cookie'};
      if(request.headers.get('If-None-Match')===etag)return new Response(null,{status:304,headers});
      const bytes=Uint8Array.from(atob(image.data),c=>c.charCodeAt(0));
      return new Response(bytes,{headers:{...headers,'Content-Length':String(bytes.length)}});
    }
    if (route === '/me' && request.method === 'GET') {
      const invite=user.role==='captain' ? (await db.prepare('SELECT code FROM studio_invites WHERE revoked=0 AND expires>? AND uses<max_uses ORDER BY created DESC LIMIT 1').bind(Date.now()).first())?.code : undefined;
      return json(200,{user,invite});
    }
    if (route === '/logout' && request.method === 'POST') { await db.prepare('DELETE FROM studio_sessions WHERE token=?').bind(await sha(token)).run(); return json(200,{ok:true},{'Set-Cookie':cookie(request)}); }
    if (route === '/users' && request.method === 'GET') return json(200,(await db.prepare(`SELECT id,COALESCE(NULLIF(nickname,''),name) AS name,role,created,color,avatar_version FROM studio_users WHERE active=1 ORDER BY role,name`).all()).results);
    const captain=()=>{if(user.role!=='captain')fail(403,'仅队长可以管理团队');};
    if(route==='/invites'){
      captain();
      if(request.method==='GET')return json(200,(await db.prepare('SELECT * FROM studio_invites ORDER BY created DESC').all()).results);
      if(request.method==='POST'){
        const data=await readBody(request),days=Number(data.days),uses=Number(data.maxUses);
        if(!Number.isInteger(days)||days<1||days>30||!Number.isInteger(uses)||uses<1||uses>100)fail(400,'有效期需为 1–30 天，使用次数需为 1–100');
        const invitation={id:random(),code:inviteCode(),expires:Date.now()+days*86400000,max_uses:uses,uses:0,revoked:0,created:new Date().toISOString(),author:user.id};
        await db.batch([db.prepare('INSERT INTO studio_invites VALUES(?,?,?,?,?,?,?,?)').bind(...Object.values(invitation)),activity(db,user,'invite',invitation.id)]);
        return json(201,invitation);
      }
    }
    const revoke=/^\/invites\/([a-f0-9]+)$/.exec(route);
    if(revoke && request.method==='DELETE'){captain();await db.batch([db.prepare('UPDATE studio_invites SET revoked=1 WHERE id=?').bind(revoke[1]),activity(db,user,'revoke-invite',revoke[1])]);return json(200,{ok:true});}
    const member=/^\/users\/([a-f0-9]+)$/.exec(route);
    if(member && request.method==='DELETE'){
      captain();const target=await db.prepare('SELECT id,role FROM studio_users WHERE id=? AND active=1').bind(member[1]).first();
      if(!target)fail(404,'成员不存在');if(target.role==='captain'||target.id===user.id)fail(400,'不能移除队长');
      await db.batch([db.prepare("UPDATE studio_users SET active=0 WHERE id=? AND role='member'").bind(target.id),db.prepare('DELETE FROM studio_sessions WHERE user_id=?').bind(target.id),db.prepare('DELETE FROM studio_follows WHERE user_id=?').bind(target.id),db.prepare("UPDATE studio_items SET assignee='',version=version+1,updated=? WHERE assignee=? AND status<>'done'").bind(new Date().toISOString(),target.id),activity(db,user,'remove',target.id)]);
      return json(200,{ok:true});
    }
    if(route==='/notifications' && request.method==='GET'){
      await dueNotifications(db,user);
      return json(200,(await db.prepare("SELECT * FROM studio_notifications WHERE user_id=? AND (read_at='' OR id IN (SELECT id FROM studio_notifications WHERE user_id=? ORDER BY created DESC LIMIT 200)) ORDER BY created DESC").bind(user.id,user.id).all()).results);
    }
    if(route==='/notifications/read' && request.method==='POST'){
      const data=await readBody(request);await db.prepare("UPDATE studio_notifications SET read_at=? WHERE user_id=? AND (id=? OR ?='all')").bind(new Date().toISOString(),user.id,data.id||'',data.id||'').run();return json(200,{ok:true});
    }
    const claim=/^\/items\/([a-f0-9]+)\/claim$/.exec(route);
    if(claim && ['POST','DELETE'].includes(request.method)){
      const data=await readBody(request),existing=await getItem(db,claim[1]),release=request.method==='DELETE';
      if(!['task','bug'].includes(existing.kind))fail(400,'仅任务和 BUG 可以认领或取消认领');
      if(!Number.isInteger(data.version))fail(400,'请刷新后重新操作');
      if(existing.version!==data.version)fail(409,'记录已更新，请刷新后重试');
      if(release&&existing.assignee!==user.id)fail(403,'仅当前执行人可以取消认领');
      const now=new Date().toISOString(),mutation=random(),assignee=release?'':user.id;
      const result=await db.batch([
        db.prepare("UPDATE studio_items SET assignee=?,version=version+1,updated=?,mutation=? WHERE id=? AND version=? AND assignee=? AND status<>'done' AND kind IN ('task','bug') AND EXISTS(SELECT 1 FROM studio_users WHERE id=? AND active=1) RETURNING id").bind(assignee,now,mutation,existing.id,data.version,release?user.id:'',user.id),
        db.prepare('INSERT INTO studio_activity SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(random(),user.id,release?'unclaim':'claim',existing.id,now,existing.id,mutation)
      ]);
      if(!result[0].results.length)fail(409,'记录已被认领、完成或更新，请刷新后查看');
      await changeNotifications(db,user,existing.id,{...existing,assignee},existing);
      return json(200,localItem(publicItem(await getItem(db,existing.id)),env));
    }
    const follow=/^\/items\/([a-f0-9]+)\/follow$/.exec(route);
    if(follow && ['POST','DELETE'].includes(request.method)){
      await getItem(db,follow[1]);
      await db.prepare(request.method==='POST'?'INSERT OR IGNORE INTO studio_follows VALUES(?,?)':'DELETE FROM studio_follows WHERE item_id=? AND user_id=?').bind(follow[1],user.id).run();return json(200,{ok:true});
    }
    if (route === '/items' && request.method === 'GET') {
      const rows=(await db.prepare("SELECT i.*,(SELECT COALESCE(NULLIF(nickname,''),name) FROM studio_users WHERE id=i.author) AS authorName,(SELECT COALESCE(NULLIF(nickname,''),name) FROM studio_users WHERE id=i.assignee) AS assigneeName,(SELECT color FROM studio_users WHERE id=i.assignee) AS assigneeColor,(SELECT COUNT(*) FROM studio_images m WHERE m.item_id=i.id) AS imageCount,EXISTS(SELECT 1 FROM studio_follows f WHERE f.item_id=i.id AND f.user_id=?) AS following FROM studio_items i ORDER BY i.updated DESC").bind(user.id).all()).results;
      const edges=(await db.prepare('SELECT * FROM studio_dependencies').all()).results;
      return json(200,rows.map(x=>({...x,tags:normalizeTags(x.tags),status:x.blocked_reason?'blocked':x.status,dependencies:edges.filter(e=>e.item_id===x.id).map(e=>e.predecessor)})));
    }
    const imgRoute = /^\/images\/([a-f0-9]{32,48})$/.exec(route);
    if (imgRoute && request.method === 'GET') {
      const image = await db.prepare('SELECT i.type,d.data FROM studio_images i JOIN studio_image_data d ON d.id=i.id WHERE i.id=?').bind(imgRoute[1]).first();
      if (!image) fail(404, '图片不存在');
      return new Response(Uint8Array.from(atob(image.data), c => c.charCodeAt(0)), { headers: { ...security, 'Content-Type': image.type, 'Content-Disposition': 'inline' } });
    }
    const match = /^\/items\/([a-f0-9]{32,48})$/.exec(route);
    if (match && request.method === 'GET') return json(200, localItem(publicItem(await getItem(db, match[1])),env));
    if ((route === '/items' && request.method === 'POST') || (match && request.method === 'PUT')) {
      const data = await readBody(request), images = parseImages(data.newImages,env.LOCAL_MODE);
      const itemId = match?.[1] || random(), existing = match ? await getItem(db, itemId) : null;
      const fields=await fieldsFor(db,data,existing);
      if (existing && data.version !== existing.version) fail(409, '其他成员已更新这条记录，请重新打开后编辑');
      const keep = existing && Array.isArray(data.keepImages) ? data.keepImages.map(x=>env.LOCAL_MODE&&typeof x==='string'?x.replace('/api',BASE):x) : existing?null:[];
      if (!Array.isArray(keep) || new Set(keep).size !== keep.length || keep.some(src => !existing?.images.includes(src)) || keep.length + images.length > 5) fail(400, '附件无效，最多添加 5 张图片');
      const keepMeta = existing?.imageMeta.filter(x => keep.includes(`${BASE}/images/${x.id}`)) || [];
      if (keepMeta.reduce((n, x) => n + x.size, 0) + images.reduce((n, x) => n + x.bytes.length, 0) > (env.LOCAL_MODE?8*1024*1024:5*512*1024)) fail(400, '所有图片总大小不能超过 2.5MB');
      const now = new Date().toISOString(), mutation = random();
      const removed = existing?.imageMeta.filter(x => !keep.includes(`${BASE}/images/${x.id}`)) || [];
      const extras=await extraFields(db,data,existing,user,itemId);
      const statements = [existing ? db.prepare('UPDATE studio_items SET kind=?,title=?,body=?,status=?,assignee=?,priority=?,due=?,version=version+1,updated=?,mutation=?,eta=?,progress=?,remaining=?,eta_reason=?,blocked_reason=?,tags=?,category=? WHERE id=? AND version=? RETURNING id').bind(...fields, now, mutation,...extras.values, itemId, data.version) : db.prepare('INSERT INTO studio_items(id,kind,title,body,status,assignee,priority,due,version,created,updated,author,mutation,eta,progress,remaining,eta_reason,blocked_reason,tags,category) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id').bind(itemId, ...fields, 1, now, now, user.id, mutation,...extras.values)];
      for (const image of removed) statements.push(db.prepare('DELETE FROM studio_images WHERE id=? AND EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(image.id, itemId, mutation));
      for (const image of images) {
        statements.push(db.prepare('INSERT INTO studio_images(id,item_id,type,size) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(image.id, itemId, image.type, image.bytes.length, itemId, mutation));
        statements.push(db.prepare('INSERT INTO studio_image_data(id,data) SELECT ?,? WHERE EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(image.id, image.data, itemId, mutation));
      }
      statements.push(db.prepare('DELETE FROM studio_dependencies WHERE item_id=? AND EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(itemId,itemId,mutation));
      for(const dependency of extras.dependencies)statements.push(db.prepare('INSERT INTO studio_dependencies SELECT ?,? WHERE EXISTS(SELECT 1 FROM studio_items WHERE id=? AND mutation=?)').bind(itemId,dependency,itemId,mutation));
      // Cycle trigger validates against the committed graph, including concurrent writers.
      const result = await db.batch(statements);
      if (!result[0].results.length) fail(409, '其他成员已更新这条记录，请重新打开后编辑');
      await changeNotifications(db,user,itemId,data,existing);
      return json(existing ? 200 : 201, localItem(publicItem(await getItem(db, itemId)),env));
    }
    if (match && request.method === 'DELETE') {
      const data = await readBody(request), existing = await getItem(db, match[1]);
      if (!Number.isInteger(data.version)) fail(400, '版本号无效');
      if (existing.version !== data.version) fail(409, '记录已被更新，请重新打开后删除');
      const dependents=(await db.prepare('SELECT item_id FROM studio_dependencies WHERE predecessor=?').bind(match[1]).all()).results;
      if(dependents.length && !data.confirmDependencies)fail(409,'此记录是其他任务的前置项，删除将解除依赖，请确认后重试');
      const result = await db.prepare('DELETE FROM studio_items WHERE id=? AND version=? RETURNING id').bind(match[1], data.version).all();
      if (!result.results.length) fail(409, '记录已被更新，请重新打开后删除');
      for(const dep of dependents)await notifyItem(db,dep.item_id,'前置任务已删除，请检查工作安排',`deleted:${match[1]}:${existing.version}`);
      return json(200, { ok: true });
    }
    fail(404, '接口不存在');
  } catch (error) {
    if(String(error.message).includes('dependency cycle'))return json(400,{error:'不能创建循环依赖'});
    if (!Number.isInteger(error.status)) console.error('Studio API error', error);
    return json(Number.isInteger(error.status) ? error.status : 500, { error: Number.isInteger(error.status) ? error.message : '协作服务暂时无法处理请求，请检查数据库迁移和服务配置' });
  }
}

function localItem(item,env){return env.LOCAL_MODE?{...item,images:item.images.map(x=>x.replace(BASE,'/api'))}:item;}
function activity(db,user,event,target){return db.prepare('INSERT INTO studio_activity VALUES(?,?,?,?,?)').bind(random(),user.id,event,target,new Date().toISOString());}
async function extraFields(db,data,existing,user,itemId){
  const values=['eta','progress','remaining','eta_reason','blocked_reason'].map((key,i)=>text(data[key]??existing?.[key]??'',i===0?40:2000));
  if(values[0] && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(values[0])||!Number.isFinite(Date.parse(values[0]))))fail(400,'预计完成时间需包含有效日期、时间和时区');
  if(values[0]){if(new Date(values[0].slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==values[0].slice(0,10))fail(400,'预计完成日期无效');values[0]=new Date(values[0]).toISOString();}
  if(data.status==='blocked'&&!values[4])fail(400,'请填写阻塞原因');
  if(data.status!=='blocked')values[4]='';
  if(existing && user.id!==existing.assignee && user.role!=='captain' && values.slice(0,4).some((v,i)=>v!==existing[['eta','progress','remaining','eta_reason'][i]]))fail(403,'仅执行人或队长可以更新进度和预计完成时间');
  const dependencies=data.dependencies??existing?.dependencies??[];
  if(!Array.isArray(dependencies)||dependencies.length>30||new Set(dependencies).size!==dependencies.length||dependencies.some(x=>typeof x!=='string'))fail(400,'前置任务无效或超过 30 项');
  const all=(await db.prepare('SELECT id,kind,status,blocked_reason FROM studio_items').all()).results;
  for(const dep of dependencies){if(dep===itemId)fail(400,'不能依赖自身');if(!all.some(x=>x.id===dep&&x.kind==='task'))fail(400,'前置任务不存在或不是任务');}
  if(data.kind!=='task'&&dependencies.length)fail(400,'仅任务可设置前置任务');
  if(existing?.kind==='task'&&data.kind!=='task' && await db.prepare('SELECT item_id FROM studio_dependencies WHERE predecessor=? LIMIT 1').bind(itemId).first())fail(400,'此任务被其他任务依赖，不能更改类型');
  if(data.status==='done'&&dependencies.some(id=>all.find(x=>x.id===id)?.status!=='done'))fail(400,'前置任务尚未完成，不能完成当前任务');
  const tags=data.tags??existing?.tags??[];
  if(!Array.isArray(tags)||tags.length>MAX_TASK_TAGS||new Set(tags).size!==tags.length||tags.some(tag=>!tagsFor(data.kind).includes(tag)&&!existing?.tags?.includes(tag)))fail(400,`标签无效，最多选择 ${MAX_TASK_TAGS} 项`);
  values.push(JSON.stringify(tags));
  const category=data.kind==='task'?(data.category??existing?.category??inferTaskCategory(data.title)):'';
  if(data.kind==='task'&&!TASK_CATEGORIES.includes(category))fail(400,'任务分类无效，请选择角色、地图、物品或机制');
  values.push(category);
  return {values,dependencies};
}
async function notify(db,userId,itemId,title,event){
  if(!userId)return;
  await db.prepare("INSERT OR IGNORE INTO studio_notifications(id,user_id,item_id,title,event_key,created) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM studio_users WHERE id=? AND active=1)").bind(random(),userId,itemId,title,event,new Date().toISOString(),userId).run();
}
async function notifyItem(db,itemId,title,event,actor=''){
  const people=(await db.prepare("SELECT assignee AS id FROM studio_items WHERE id=? UNION SELECT user_id AS id FROM studio_follows WHERE item_id=?").bind(itemId,itemId).all()).results;
  for(const person of people)if(person.id!==actor)await notify(db,person.id,itemId,title,event);
}
async function changeNotifications(db,user,itemId,data,existing){
  const event=`change:${itemId}:${existing?existing.version+1:1}`;
  if(data.assignee&&data.assignee!==existing?.assignee)await notify(db,data.assignee,itemId,`你被分配了：${data.title}`,`assigned:${event}`);
  if(existing)await notifyItem(db,itemId,`记录已更新：${data.title}`,event,user.id);
  if((data.status==='done')!==(existing?.status==='done')){
    const downstream=(await db.prepare('SELECT item_id FROM studio_dependencies WHERE predecessor=?').bind(itemId).all()).results;
    for(const dep of downstream)await notifyItem(db,dep.item_id,data.status==='done'?`前置任务已完成，请检查是否可以接手：${data.title}`:`前置任务已重新打开，请重新安排：${data.title}`,`dependency:${event}`);
  }
}
async function dueNotifications(db,user){
  const rows=(await db.prepare("SELECT DISTINCT i.* FROM studio_items i LEFT JOIN studio_follows f ON f.item_id=i.id AND f.user_id=? WHERE i.status<>'done' AND (i.assignee=? OR f.user_id=?)").bind(user.id,user.id,user.id).all()).results;
  const now=Date.now();
  for(const item of rows){
    for(const [key,date] of [['due',item.due?item.due+'T23:59:59+08:00':''],['eta',item.eta]]){
      if(!date)continue;const delta=Date.parse(date)-now;
      if(delta>86400000)continue;
      const state=delta<0?'overdue':'soon';
      await notify(db,user.id,item.id,`${delta<0?'已逾期':'即将到期'}（${key==='eta'?'预计完成':'截止日期'}）：${item.title}`,`${key}:${item.id}:${date}:${state}`);
    }
  }
}
