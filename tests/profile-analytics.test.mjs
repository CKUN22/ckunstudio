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
 function settings(mode,protectSite=true){sql.prepare("INSERT INTO studio_settings(key,value) VALUES('site_verification',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({mode,protectSite}));}
 return {sql,db,env,request,req,settings};
}
for(const local of [false,true])test(`用户资料与头像：${local?'SQLite':'D1 兼容'} 昵称独立、缓存版本、鉴权与大小`,async()=>{
 const h=harness(local);h.settings('off');const a=await h.req('/setup','','POST',{name:'owner',password:'owner-strong-password',setupKey:h.env.STUDIO_SETUP_KEY});assert.equal(a.status,201);const captain='unrelated=cookie; '+a.cookie;
 const b=await h.req('/register','','POST',{name:'member',password:'member-strong-password',invite:a.data.invite});const member=b.cookie;
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
 assert.equal((await h.req('/me','','PUT',{nickname:'X'})).status,401);
 const changed=await h.req('/me',member,'PUT',{nickname:'新昵称 <test>',avatar:image,id:a.data.user.id,role:'captain'});assert.equal(changed.status,200);assert.equal(changed.data.user.name,'新昵称 <test>');assert.equal(changed.data.user.loginName,'member');assert.equal(changed.data.user.role,'member');assert.equal(changed.data.user.siteAdmin,false);
 assert.equal((await h.req('/login','','POST',{name:'member',password:'member-strong-password'})).status,200);assert.equal((await h.req('/login','','POST',{name:'新昵称 <test>',password:'member-strong-password'})).status,401);
 const self=(await h.req('/me',member)).data.user;assert.equal(self.avatar_version.length,64);const url=`/avatars/${self.id}?v=${self.avatar_version}`;
 assert.equal((await h.req(url)).status,401);const binary=await h.req(url,captain);assert.equal(binary.status,200);assert.match(binary.headers.get('cache-control'),/private.*immutable/);assert.equal(binary.headers.get('content-type'),'image/png');assert.equal((await h.req(url,captain,'GET',undefined,{'If-None-Match':binary.headers.get('etag')})).status,304);
 assert.equal((await h.req('/avatars/'+self.id+'?v=wrong',captain)).status,404);
 const huge=Buffer.alloc(256*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(huge);assert.equal((await h.req('/me',member,'PUT',{nickname:'must-not-save',avatar:'data:image/png;base64,'+huge.toString('base64')})).status,400);
 assert.equal((await h.req('/me',member,'PUT',{nickname:'bad',avatar:'data:image/svg+xml;base64,PHN2Zy8+'})).status,400);assert.equal((await h.req('/me',member)).data.user.name,'新昵称 <test>');
 assert.equal((await h.req('/me',member,'PUT',{nickname:'X'}, {Origin:'https://evil.test'})).status,403);
 assert.equal((await h.req('/admin/analytics',member)).status,403);assert.equal((await h.req('/admin/verification',member,'PUT',{mode:'off',protectSite:false})).status,403);
 const removal=await h.req('/me',member,'PUT',{nickname:'成员',avatar:null});assert.equal(removal.data.user.avatar_version,'');assert.equal((await h.req(url,captain)).status,404);
 assert.equal((await h.req('/admin/verification',captain,'PUT',{mode:'turnstile',protectSite:true})).status,400);
 h.env.SITE_ADMIN_USER_IDS=self.id;assert.equal((await h.req('/admin/analytics',captain)).status,403);assert.equal((await h.req('/admin/analytics',member)).status,200);
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
 const report=await h.req('/admin/analytics?start=2020-01-01&end=2020-01-01',first.cookie);assert.equal(report.status,200);assert.equal(report.data.daily[0].pages,2);assert.equal(report.data.retention.first_day,'2020-01-01');assert.equal((await h.req('/admin/analytics?start=2020-01-01&end=2026-01-01',first.cookie)).status,400);
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
