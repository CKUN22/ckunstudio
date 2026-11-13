import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {scryptSync,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

test('旧本地数据库升级：队长、原密码、旧会话、历史记录和图片完整保留',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'studio-p0-upgrade-')),db=new DatabaseSync(path.join(dir,'studio.db'));
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,password TEXT NOT NULL,salt TEXT NOT NULL);
 CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
 CREATE TABLE items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,assignee TEXT NOT NULL,priority TEXT NOT NULL,due TEXT NOT NULL,version INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,author TEXT NOT NULL);
 CREATE TABLE images(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,type TEXT NOT NULL,bytes BLOB NOT NULL);
 CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 const uid='a'.repeat(32),uid2='b'.repeat(32),item='c'.repeat(32),image='d'.repeat(32),token='e'.repeat(32),salt='legacy-salt',password='legacy-password-123';
 for(const [id,name] of [[uid,'原队长'],[uid2,'原成员']])db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,name,scryptSync(password,salt,64).toString('hex'),salt);
 db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),uid2,Date.now()+86400000);
 db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(item,'task','历史关卡','原始正文','done',uid2,'normal','',1,'2026-10-01','2026-10-02',uid2);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
 db.prepare('INSERT INTO images VALUES(?,?,?,?)').run(image,item,'image/png',png);db.prepare('INSERT INTO settings VALUES(?,?)').run('invite','old-permanent-invite');db.close();
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));let child;
 async function start(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:dir,PORT:String(port)},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.stderr.on('data',x=>process.stderr.write(x));child.once('error',reject);child.once('exit',code=>reject(new Error('Server exited '+code)));});}
 async function stop(){if(!child||child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});await start();
 async function req(route,cookie='session='+token,data){const res=await fetch(`http://127.0.0.1:${port}/api`+route,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};}
 const me=await req('/me');assert.equal(me.status,200);assert.equal(me.data.user.role,'member');assert.equal(me.data.invite,undefined);
 const users=await req('/users');assert.equal(users.data.find(x=>x.id===uid).role,'captain');assert.equal(users.data.filter(x=>x.role==='captain').length,1);
 const original=await req('/items/'+item);assert.equal(original.data.authorName,'原成员');assert.equal(original.data.title,'历史关卡');assert.equal(original.data.body,'原始正文');
 const picture=await fetch(`http://127.0.0.1:${port}`+original.data.images[0],{headers:{Cookie:'session='+token}});assert.equal(picture.status,200);assert.deepEqual(Buffer.from(await picture.arrayBuffer()),png);
 const login=await req('/login','',{name:'原队长',password});assert.equal(login.status,200);assert.equal(login.data.user.role,'captain');assert.equal((await req('/invites',login.cookie)).data.length,0);
 assert.equal((await req('/register','',{name:'旧邀请',password,invite:'old-permanent-invite'})).status,403);
 await stop();await start();assert.equal((await req('/me')).data.user.role,'member');assert.equal((await req('/items/'+item)).data.title,'历史关卡');
});

test('旧 D1 迁移：明确指定最早账号为唯一队长并停用永久邀请码',()=>{
 const db=new DatabaseSync(':memory:');for(const file of ['0001_studio.sql','0002_d1_image_data.sql'])db.exec(readFileSync('cloudflare/site/migrations/studio/'+file,'utf8'));
 for(const [id,created] of [['later','2026-11-02'],['first','2026-11-01']])db.prepare('INSERT INTO studio_users VALUES(?,?,?,?,?)').run(id,id,'hash','salt',created);
 db.prepare('INSERT INTO studio_settings VALUES(?,?)').run('invite','legacy');db.exec(readFileSync('cloudflare/site/migrations/studio/0003_p0.sql','utf8'));db.exec(readFileSync('cloudflare/site/migrations/studio/0004_task_claims.sql','utf8'));
 assert.equal(db.prepare("SELECT id FROM studio_users WHERE role='captain'").get().id,'first');assert.equal(db.prepare("SELECT * FROM studio_settings WHERE key='invite'").get(),undefined);assert.equal(db.prepare('SELECT count(*) n FROM studio_users WHERE active=1').get().n,2);assert.equal(db.prepare('SELECT count(DISTINCT color) n FROM studio_users').get().n,2);db.close();
});
