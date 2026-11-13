import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

test('团队协作：认证、邀请、三类记录、图片、冲突和持久化', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'studio-flow-test-'));
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  let child;
  async function start(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:dir,PORT:String(port)},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{child.stderr.on('data',chunk=>process.stderr.write(chunk));child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('Server exited '+code)));});}
  async function stop(){if(!child||child.exitCode!==null)return;const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  await start();
  const base=`http://127.0.0.1:${port}`;
  async function request(route,{cookie,method='GET',data,origin}={}){const response=await fetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const result=await response.json();return {status:response.status,data:result,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  assert.equal((await request('/api/setup')).data.needsSetup,true);
  const catalog=await fetch(base+'/task-catalog.js');assert.equal(catalog.status,200);assert.equal(catalog.headers.get('cache-control'),'no-store');assert.match(await catalog.text(),/瓦片/);
  assert.equal((await request('/api/items')).status,401);
  const first=await request('/api/setup',{method:'POST',data:{name:'策划',password:'strong-password-123'}});
  assert.equal(first.status,201);const cookie=first.cookie,invite=first.data.invite;
  assert.equal((await request('/api/setup',{method:'POST',data:{name:'攻击',password:'strong-password-123'}})).status,409);
  assert.equal((await request('/api/register',{method:'POST',data:{name:'程序',password:'strong-password-456',invite:'wrong'}})).status,403);
  const second=await request('/api/register',{method:'POST',data:{name:'程序',password:'strong-password-456',invite}});
  assert.equal(second.status,200);const cookie2=second.cookie;
  assert.equal((await request('/api/login',{method:'POST',data:{name:'策划',password:'wrong-password'}})).status,401);
  const userList=await request('/api/users',{cookie});assert.equal(userList.data.length,2);assert.equal(userList.data[0].password,undefined);
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
  const payload={kind:'task',title:'完成关卡原型',body:'验收：可从入口抵达出口',status:'todo',assignee:second.data.user.id,priority:'high',due:'2026-12-01',newImages:[image]};
  assert.equal((await request('/api/items',{cookie,method:'POST',origin:'http://evil.example',data:payload})).status,403);
  const created=await request('/api/items',{cookie,method:'POST',data:payload});assert.equal(created.status,201);assert.equal(created.data.images.length,1);const record=created.data;
  const other=await request(`/api/items/${record.id}`,{cookie:cookie2});assert.equal(other.data.title,payload.title);
  assert.equal((await fetch(base+record.images[0])).status,401);
  const img=await fetch(base+record.images[0],{headers:{Cookie:cookie2}});assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/png');
  const update={...payload,status:'doing',version:record.version,newImages:[],keepImages:record.images};
  assert.equal((await request(`/api/items/${record.id}`,{cookie:cookie2,method:'PUT',data:update})).status,200);
  assert.equal((await request(`/api/items/${record.id}`,{cookie,method:'PUT',data:update})).status,409);
  assert.equal((await request(`/api/items/${record.id}`,{cookie,method:'DELETE',data:{version:1}})).status,409);
  for(const kind of ['bug','idea'])assert.equal((await request('/api/items',{cookie,method:'POST',data:{...payload,kind,newImages:[]}})).status,201);
  assert.equal((await request('/api/items',{cookie})).data.length,3);
  assert.equal((await request('/api/items',{cookie,method:'POST',data:{...payload,newImages:['data:image/svg+xml;base64,PHN2Zz4=']}})).status,400);
  assert.equal((await request('/api/items',{cookie,method:'POST',data:{...payload,title:' '}})).status,400);
  await stop();await start();
  assert.equal((await request('/api/items',{cookie:cookie2})).data.length,3);
  const current=await request(`/api/items/${record.id}`,{cookie});
  assert.equal((await request(`/api/items/${record.id}`,{cookie,method:'DELETE',data:{version:current.data.version}})).status,200);
  assert.equal((await fetch(base+record.images[0],{headers:{Cookie:cookie}})).status,404);
  assert.equal((await request('/api/logout',{cookie,method:'POST',data:{}})).status,200);
  assert.equal((await request('/api/items',{cookie})).status,401);
});
