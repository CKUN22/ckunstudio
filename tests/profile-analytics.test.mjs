import {onRequest as adminRequest,hashAdminPassword} from '../cloudflare/site/lib/site-admin-api.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {onRequest} from '../cloudflare/site/lib/studio-api.mjs';
import {onRequest as middleware} from '../cloudflare/site/functions/_middleware.js';
import {recordTraffic,chinaDay} from '../cloudflare/site/lib/telemetry.mjs';
import {makeChallenge,solveChallenge,hasClearance} from '../cloudflare/site/lib/verification.mjs';
function harness(local=false){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync('cloudflare/site/migrations/studio').sort())sql.exec(readFileSync('cloudflare/site/migrations/studio/'+file,'utf8'));
 function prepare(query){let args=[];return {bind(...values){args=values;return this;},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return {meta:{changes:sql.prepare(query).run(...args).changes}};},execute(){return {results:sql.prepare(query).all(...args)};}};}
 const db={prepare,async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s.execute());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={STUDIO_DB:db,STUDIO_AUTH_SECRET:'test-only-auth-secret-at-least-32-characters',STUDIO_SETUP_KEY:'test-only-setup-key-at-least-24',LOCAL_MODE:local};
 const request=(path,options={})=>new Request('https://example.test'+path,{...options,headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1','User-Agent':'Mozilla/5.0 Chrome/130 Windows',...options.headers}});
 async function req(path,cookie='',method='GET',data,headers={}){const response=await onRequest({env,request:request((local?'/api':'/ckunstudio/api')+path,{method,headers:{Cookie:cookie,...headers},...(data?{body:JSON.stringify(data)}:{})})});return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():new Uint8Array(await response.arrayBuffer()),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};}
 async function admin(path,cookie='',method='GET',data,headers={}){const response=await adminRequest({env,request:request('/admin/api'+path,{method,headers:{Cookie:cookie,...headers},...(data?{body:JSON.stringify(data)}:{})})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};}
 async function seedAdmin(){const salt='disposable-test-salt';sql.prepare('INSERT INTO site_admins(id,username,password,salt,created) VALUES(?,?,?,?,?)').run('test-admin-id','admin',await hashAdminPassword('only-for-tests',salt,env.STUDIO_AUTH_SECRET),salt,new Date().toISOString());return (await admin('/login','','POST',{username:'admin',password:'only-for-tests'})).cookie;}
 function settings(mode,protectSite=true){sql.prepare("INSERT INTO studio_settings(key,value) VALUES('site_verification',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({mode,protectSite}));}
 return {sql,db,env,request,req,settings,admin,seedAdmin};
}
for(const local of [false,true])test(`用户资料与头像：${local?'SQLite':'D1 兼容'} 昵称独立、缓存版本、鉴权与大小`,async()=>{
 const h=harness(local);h.settings('off');const a=await h.req('/setup','','POST',{name:'owner',password:'owner-strong-password',setupKey:h.env.STUDIO_SETUP_KEY});assert.equal(a.status,201);const captain='unrelated=cookie; '+a.cookie;
 const b=await h.req('/register','','POST',{name:'member',password:'member-strong-password',invite:a.data.invite});const member=b.cookie;
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
 assert.equal((await h.req('/me','','PUT',{nickname:'X'})).status,401);
 const changed=await h.req('/me',member,'PUT',{nickname:'新昵称 <test>',avatar:image,id:a.data.user.id,role:'captain'});assert.equal(changed.status,200);assert.equal(changed.data.user.name,'新昵称 <test>');assert.equal(changed.data.user.loginName,'member');assert.equal(changed.data.user.role,'member');assert.equal(changed.data.user.siteAdmin,undefined);
 assert.equal((await h.req('/login','','POST',{name:'member',password:'member-strong-password'})).status,200);assert.equal((await h.req('/login','','POST',{name:'新昵称 <test>',password:'member-strong-password'})).status,401);
 const self=(await h.req('/me',member)).data.user;assert.equal(self.avatar_version.length,64);const url=`/avatars/${self.id}?v=${self.avatar_version}`;
 assert.equal((await h.req(url)).status,401);const binary=await h.req(url,captain);assert.equal(binary.status,200);assert.match(binary.headers.get('cache-control'),/private.*immutable/);assert.equal(binary.headers.get('content-type'),'image/png');assert.equal((await h.req(url,captain,'GET',undefined,{'If-None-Match':binary.headers.get('etag')})).status,304);
 assert.equal((await h.req('/avatars/'+self.id+'?v=wrong',captain)).status,404);
 const huge=Buffer.alloc(256*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(huge);assert.equal((await h.req('/me',member,'PUT',{nickname:'must-not-save',avatar:'data:image/png;base64,'+huge.toString('base64')})).status,400);
 assert.equal((await h.req('/me',member,'PUT',{nickname:'bad',avatar:'data:image/svg+xml;base64,PHN2Zy8+'})).status,400);assert.equal((await h.req('/me',member)).data.user.name,'新昵称 <test>');
 assert.equal((await h.req('/me',member,'PUT',{nickname:'X'}, {Origin:'https://evil.test'})).status,403);
 assert.equal((await h.req('/admin/analytics',member)).status,404);assert.equal((await h.req('/admin/verification',member,'PUT',{mode:'off',protectSite:false})).status,404);
 const removal=await h.req('/me',member,'PUT',{nickname:'成员',avatar:null});assert.equal(removal.data.user.avatar_version,'');assert.equal((await h.req(url,captain)).status,404);
 assert.equal((await h.admin('/analytics',captain)).status,401);
 const adminCookie=await h.seedAdmin();assert.equal((await h.admin('/analytics',adminCookie)).status,200);
 h.sql.close();
});
test('统计：按北京时间分日、PV/UV/机器人分离、范围隔离、隐私和长期保留',async()=>{
 const h=harness();h.settings('off');const response=new Response('<html>ok</html>',{headers:{'Content-Type':'text/html','Content-Length':'15'}});
 await recordTraffic({request:h.request('/?invite=private'),env:h.env},response,Date.now()-10);
 await recordTraffic({request:h.request('/?password=private'),env:h.env},response);
 await recordTraffic({request:h.request('/ckunstudio/'),env:h.env},response);
 await recordTraffic({request:h.request('/ckunstudio/',{headers:{'User-Agent':'crawlerbot'}}),env:h.env},response);
 await recordTraffic({request:h.request('/.env?key=secret'),env:h.env},new Response(null,{status:404}),Date.now(),'sensitive-path-probe');
 const before=h.sql.prepare('SELECT SUM(requests) AS n FROM site_metrics').get().n;
 await recordTraffic({request:h.request('/ckunstudio/api/items'),env:h.env},new Response('[]',{headers:{'Content-Type':'application/json'}}));assert.equal(h.sql.prepare('SELECT SUM(requests) AS n FROM site_metrics').get().n,before);
 const all=h.sql.prepare("SELECT * FROM site_metrics WHERE scope='all' AND dimension='total'").get();assert.equal(all.pages,3);assert.equal(all.requests,5);assert.equal(all.bots,1);assert.equal(all.errors,1);assert.equal(h.sql.prepare("SELECT COUNT(*) n FROM site_visitors WHERE scope='all'").get().n,1);
 const stored=JSON.stringify(h.sql.prepare('SELECT * FROM site_metrics').all());assert.doesNotMatch(stored,/password|invite|private|192\.0\.2/);
 h.sql.prepare("INSERT INTO site_metrics(day,scope,dimension,value,requests,pages) VALUES('2020-01-01','all','total','all',3,2)").run();
 const first=await h.req('/setup','','POST',{name:'owner',password:'owner-password-123',setupKey:h.env.STUDIO_SETUP_KEY});
 const adminCookie=await h.seedAdmin();const report=await h.admin('/analytics?start=2020-01-01&end=2020-01-01',adminCookie);assert.equal(report.status,200);assert.equal(report.data.daily[0].pages,2);assert.equal(report.data.retention.first_day,'2020-01-01');assert.equal((await h.admin('/analytics?start=2020-01-01&end=2026-01-01',adminCookie)).status,400);
 assert.equal(chinaDay(Date.parse('2026-11-14T16:00:00Z')),'2026-11-15');h.sql.close();
});
test('访问验证：自动计算、手动答案、重放/跨 IP 拒绝、页面门禁和探测拦截',async()=>{
 const h=harness(),request=h.request('/ckunstudio/api/verification');h.settings('auto');
 assert.equal((await h.req('/setup','','POST',{name:'owner',password:'owner-password-123',setupKey:h.env.STUDIO_SETUP_KEY})).status,403);
 const challenge=await makeChallenge(h.db,h.env,request);let nonce=0;while(!createHash('sha256').update(challenge.prefix+':'+nonce).digest('hex').startsWith('0000'))nonce++;
 const cookie=await solveChallenge(h.db,h.env,request,{token:challenge.token,nonce});assert.match(cookie,/HttpOnly.*SameSite=Lax/);assert.equal(await hasClearance(h.env,h.request('/',{headers:{Cookie:cookie}})),true);assert.equal(await hasClearance(h.env,h.request('/',{headers:{Cookie:cookie,'CF-Connecting-IP':'192.0.2.2'}})),false);
 await assert.rejects(solveChallenge(h.db,h.env,request,{token:challenge.token,nonce}),/已使用/);
 h.settings('manual');const manual=await makeChallenge(h.db,h.env,request);const svg=Buffer.from(manual.image.split(',')[1],'base64').toString();const answer=[...svg.matchAll(/fill="#294b37">([^<]+)<\/text>/g)].map(m=>m[1]).join('');assert.equal(answer.length,6);await assert.rejects(solveChallenge(h.db,h.env,request,{token:manual.token,answer:'wrong'}),/不正确/);assert.match(await solveChallenge(h.db,h.env,request,{token:manual.token,answer}),/ckun_clearance=/);
 const tasks=[],context={request:h.request('/'),env:h.env,data:{},waitUntil:p=>tasks.push(p),next:async()=>new Response('<html>site</html>',{headers:{'Content-Type':'text/html'}})};
 const denied=await middleware(context);assert.equal(denied.status,403);assert.match(await denied.text(),/访问保护/);await Promise.all(tasks);
 const allowed=await middleware({...context,data:{},request:h.request('/',{headers:{Cookie:cookie}})});assert.equal(allowed.status,200);await Promise.all(tasks);
 const blocked=await middleware({...context,data:{},request:h.request('/.env')});assert.equal(blocked.status,404);await Promise.all(tasks);h.sql.close();
});

test('独立网站后台：账号及会话隔离、只读白名单、跨站写入拒绝',async()=>{
 const h=harness();h.settings('off');
 const studio=await h.req('/setup','','POST',{name:'studio-owner',password:'studio-only-password',setupKey:h.env.STUDIO_SETUP_KEY});assert.equal(studio.status,201);
 const admin=await h.seedAdmin();assert.ok(admin);const login=await h.admin('/login','','POST',{username:'admin',password:'only-for-tests'});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/Path=\/admin; HttpOnly; SameSite=Strict/);assert.match(login.headers.get('set-cookie'),/Secure/);
 assert.equal((await h.admin('/me',studio.cookie)).status,401);assert.equal((await h.admin('/me',studio.cookie.replace('ckunstudio_session','ckun_admin_session'))).status,401);
 assert.equal((await h.req('/me',admin.replace('ckun_admin_session','ckunstudio_session'))).status,401);
 assert.equal((await h.admin('/login','','POST',{username:'studio-owner',password:'studio-only-password'})).status,401);
 assert.equal((await h.admin('/login','','POST',{username:'admin',password:'wrong'})).status,401);
 assert.equal((await h.admin('/login','','POST',{username:"admin' OR 1=1 --",password:'only-for-tests'})).status,401);
 const changes=h.sql.prepare('SELECT total_changes() n').get().n;
 assert.equal((await h.admin('/analytics',admin)).status,200);assert.equal((await h.admin('/me',admin)).data.user.username,'admin');assert.equal(h.sql.prepare('SELECT total_changes() n').get().n,changes,'viewing reports must not write business data');
 for(const [path,method] of [['/settings/verification','PUT'],['/users','POST'],['/execute','POST'],['/backup','POST'],['/analytics','DELETE'],['/analytics','POST']])assert.ok([404,405].includes((await h.admin(path,admin,method,{})).status),path);
 assert.equal((await h.admin('/logout',admin,'POST',{}, {Origin:'https://evil.test'})).status,403);
 assert.equal((await h.admin('/logout',admin,'POST',{})).status,200);assert.equal((await h.admin('/me',admin)).status,401);assert.equal((await h.req('/me',studio.cookie)).status,200);
 const count=h.sql.prepare('SELECT SUM(requests) n FROM site_metrics').get().n;
 await recordTraffic({request:h.request('/admin/'),env:h.env},new Response('<html/>',{headers:{'Content-Type':'text/html'}}));assert.equal(h.sql.prepare('SELECT SUM(requests) n FROM site_metrics').get().n,count);
 h.sql.close();
});

test('前端分离：协作软件无后台入口，独立后台只含查询与登录登出',()=>{
 const studio=readFileSync('public/app.js','utf8'),admin=readFileSync('cloudflare/site/public/admin/admin.js','utf8');
 assert.doesNotMatch(studio,/renderAdmin|网站管理|\/api\/admin/);
 assert.match(admin,/\/admin\/api\/analytics/);assert.doesNotMatch(admin,/protection-form|保存设置|\/settings\/verification|method:'PUT'|method:'DELETE'|downloadReport/);
 assert.match(readFileSync('cloudflare/site/public/admin/index.html','utf8'),/只读数据展示/);
});
