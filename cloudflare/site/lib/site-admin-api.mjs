import {trafficReport} from './telemetry.mjs';
import {verificationSettings,hasClearance} from './verification.mjs';
const encoder=new TextEncoder(),COOKIE='ckun_admin_session',BASE='/admin/api';
const security={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const json=(status,data,headers={})=>new Response(JSON.stringify(data),{status,headers:{...security,...headers}});
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const hex=value=>Array.from(new Uint8Array(value),x=>x.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(24)));
const sha=async value=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;};
export async function hashAdminPassword(password,salt,secret){
 const pepper=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const material=await crypto.subtle.sign('HMAC',pepper,encoder.encode(password));
 const key=await crypto.subtle.importKey('raw',material,'PBKDF2',false,['deriveBits']);
 return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256));
}
function cookie(request,token=''){return `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${token?43200:0}${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
function tokenFrom(request){const token=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);return /^[a-f0-9]{48}$/.test(token||'')?token:'';}
async function body(request){
 const chunks=[];let size=0;if(!request.body)return {};
 const reader=request.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();fail(413,'请求过大');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{const data=JSON.parse(new TextDecoder().decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))fail(400,'请求格式错误');return data;}catch{fail(400,'请求格式错误');}
}
async function limit(db,request){
 const now=Date.now(),window=Math.floor(now/900000),key=await sha(`${request.headers.get('CF-Connecting-IP')||'local'}:${window}`);
 const row=await db.prepare('INSERT INTO site_admin_limits(key,attempts,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(key,(window+1)*900000).first();
 await db.prepare('DELETE FROM site_admin_limits WHERE expires<?').bind(now).run();
 if(row.attempts>20)fail(429,'尝试过于频繁，请 15 分钟后再试');
}
export async function onRequest({request,env}){
 try{
  const url=new URL(request.url);if(!url.pathname.startsWith(BASE+'/'))fail(404,'接口不存在');
  const route=url.pathname.slice(BASE.length).replace(/\/$/,'');
  // The allowlist is deliberately read-only except for sign-in and sign-out.
  if(!['/login','/logout','/me','/analytics'].includes(route))fail(404,'接口不存在');
  const allowed=route==='/login'||route==='/logout'?'POST':'GET';if(request.method!==allowed)fail(405,'后台仅支持数据查询');
  if(!env.STUDIO_DB||!env.STUDIO_AUTH_SECRET||env.STUDIO_AUTH_SECRET.length<32)fail(503,'管理服务暂时不可用');
  const db=env.STUDIO_DB.withSession?env.STUDIO_DB.withSession('first-primary'):env.STUDIO_DB;
  if(request.method==='POST'){
   if(request.headers.get('Sec-Fetch-Site')==='cross-site'||(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin))fail(403,'请求来源无效');
   if(!request.headers.get('Content-Type')?.startsWith('application/json'))fail(415,'请使用 JSON 请求');
  }
  if(route==='/login'){
   await limit(db,request);
   const protection=await verificationSettings(db,env);if(protection.mode!=='off'&&!await hasClearance(env,request))fail(403,'请先完成网站访问验证');
   const data=await body(request);if(typeof data.username!=='string'||data.username.trim().length>40||typeof data.password!=='string'||!data.password||data.password.length>200)fail(400,'请输入有效账号和密码');
   const admin=await db.prepare('SELECT * FROM site_admins WHERE username=?').bind(data.username.trim()).first();
   const digest=await hashAdminPassword(data.password,admin?.salt||'unknown-admin-dummy-salt',env.STUDIO_AUTH_SECRET);
   if(!admin||!admin.active||!equal(digest,admin.password))fail(401,'账号或密码不正确');
   const token=random();await db.batch([db.prepare('DELETE FROM site_admin_sessions WHERE expires<?').bind(Date.now()),db.prepare('INSERT INTO site_admin_sessions(token,admin_id,expires) VALUES(?,?,?)').bind(await sha(token),admin.id,Date.now()+43200000)]);
   return json(200,{user:{username:admin.username}},{'Set-Cookie':cookie(request,token)});
  }
  const token=tokenFrom(request),admin=token&&await db.prepare('SELECT a.id,a.username FROM site_admin_sessions s JOIN site_admins a ON a.id=s.admin_id WHERE s.token=? AND s.expires>? AND a.active=1').bind(await sha(token),Date.now()).first();
  if(!admin)fail(401,'请登录网站管理员账号');
  if(route==='/me')return json(200,{user:{username:admin.username}});
  if(route==='/logout'){await db.prepare('DELETE FROM site_admin_sessions WHERE token=?').bind(await sha(token)).run();return json(200,{ok:true},{'Set-Cookie':cookie(request)});}
  return json(200,await trafficReport(db,url));
 }catch(error){if(!error.status)console.error('Admin API failed');return json(error.status||500,{error:error.status?error.message:'管理服务暂时不可用'});}
}
