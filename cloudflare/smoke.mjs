import assert from 'node:assert/strict';
const base = process.argv[2] || 'http://127.0.0.1:8790';
if (!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname)) throw new Error('Smoke tests only run on localhost, never production');
const api = `${base}/ckunstudio/api`;
async function request(route,{cookie,method='GET',data,origin}={}) {
  const response=await fetch(api+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{})},...(data?{body:JSON.stringify(data)}:{})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
const name='Cloudflare本地自测',password='local-smoke-only-123456789';
let first;
const setup=await request('/setup');assert.equal(setup.status,200);assert.equal(setup.data.setupKeyRequired,true);
if(setup.data.needsSetup){
  assert.equal((await request('/setup',{method:'POST',data:{name,password,setupKey:'wrong'}})).status,403);
  const results=await Promise.all([1,2].map(()=>request('/setup',{method:'POST',data:{name,password,setupKey:'local-setup-key-do-not-use-in-production'}})));
  assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);first=results.find(x=>x.status===201);
} else first=await request('/login',{method:'POST',data:{name,password}});
assert.ok([200,201].includes(first.status));assert.ok(first.cookie.startsWith('ckunstudio_session='));
const cookie=first.cookie;assert.match(first.headers.get('set-cookie'),/Path=\/ckunstudio/);assert.match(first.headers.get('set-cookie'),/HttpOnly/);
assert.equal((await request('/items')).status,401);
assert.equal((await request('/login',{method:'POST',data:{name,password:'wrong'}})).status,401);
const me=await request('/me',{cookie});assert.equal(me.data.user.name,name);assert.equal(me.data.user.password,undefined);
const invite=me.data.invite;
assert.equal((await request('/register',{method:'POST',data:{name:'第二位本地自测',password,invite:'wrong'}})).status,403);
let second=await request('/register',{method:'POST',data:{name:'第二位本地自测',password,invite}});
if(second.status===409)second=await request('/login',{method:'POST',data:{name:'第二位本地自测',password}});
assert.equal(second.status,200);const cookie2=second.cookie;
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
const payload={kind:'task',title:'Cloudflare 自测任务',body:'测试 D1 记录及小图附件',status:'todo',assignee:second.data.user.id,priority:'high',due:'2026-12-01',newImages:[image]};
assert.equal((await request('/items',{cookie,method:'POST',origin:'https://evil.example',data:payload})).status,403);
const created=await request('/items',{cookie,method:'POST',data:payload});assert.equal(created.status,201,JSON.stringify(created.data));const record=created.data;assert.equal(record.images.length,1);
const url=base+record.images[0];assert.equal((await fetch(url)).status,401);const img=await fetch(url,{headers:{Cookie:cookie2}});assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/png');assert.ok((await img.arrayBuffer()).byteLength>0);
const loaded=await request(`/items/${record.id}`,{cookie:cookie2});assert.equal(loaded.data.title,payload.title);
const updated=await Promise.all(['doing','done'].map(status=>request(`/items/${record.id}`,{cookie:cookie2,method:'PUT',data:{...payload,status,version:record.version,keepImages:record.images,newImages:[]}})));
assert.deepEqual(updated.map(x=>x.status).sort(),[200,409]);
assert.equal((await request(`/items/${record.id}`,{cookie,method:'DELETE',data:{version:1}})).status,409);
const temporary=[record.id];
for(const kind of ['bug','idea']){const result=await request('/items',{cookie,method:'POST',data:{...payload,kind,newImages:[]}});assert.equal(result.status,201);temporary.push(result.data.id);}
const list=await request('/items',{cookie:cookie2});for(const id of temporary)assert.ok(list.data.some(x=>x.id===id));assert.equal(list.data.find(x=>x.id===record.id).imageCount,1);
assert.equal((await request('/items',{cookie,method:'POST',data:{...payload,newImages:['data:image/svg+xml;base64,PHN2Zz4=']}})).status,400);
const oversized=Buffer.alloc(512*1024+1);Buffer.from([137,80,78,71,13,10,26,10]).copy(oversized);
assert.equal((await request('/items',{cookie,method:'POST',data:{...payload,newImages:['data:image/png;base64,'+oversized.toString('base64')]}})).status,400);
assert.equal((await request('/items',{cookie,method:'POST',data:{...payload,due:'2026-02-31'}})).status,400);
const current=await request(`/items/${record.id}`,{cookie});assert.equal((await request(`/items/${record.id}`,{cookie,method:'PUT',data:{...payload,version:current.data.version,keepImages:[],newImages:[]}})).status,200);
assert.equal((await fetch(url,{headers:{Cookie:cookie2}})).status,404);
for(const id of temporary){const item=await request(`/items/${id}`,{cookie});assert.equal((await request(`/items/${id}`,{cookie,method:'DELETE',data:{version:item.data.version}})).status,200);}
const home=await fetch(base+'/');assert.equal(home.status,200);const homeText=await home.text();assert.ok(homeText.includes('CKUN'));assert.match(homeText,/href="\/ckunstudio\/"/);
const studio=await fetch(base+'/CK_STUDIO');assert.equal(studio.status,200);assert.doesNotMatch(await studio.text(),/href="\/ckunstudio\/?"/);
const app=await fetch(base+'/ckunstudio');assert.equal(app.status,200);assert.match(app.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.ok((await app.text()).includes('/ckunstudio/app.js'));
assert.equal((await fetch(base+'/ckunstudio/app.js')).status,200);assert.equal((await fetch(base+'/ckunstudio/style.css')).status,200);
assert.equal((await fetch(base+'/privacy/moshumiyin/')).status,200);
assert.equal((await request('/logout',{cookie,method:'POST',data:{}})).status,200);assert.equal((await request('/items',{cookie})).status,401);
console.log('PASS: Cloudflare Pages routing + D1 records and private images + 512KB limit + protected setup race + two accounts + concurrent edit conflict + validation + logout + original site pages');
