import {scryptSync,timingSafeEqual} from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest } from './cloudflare/site/lib/studio-api.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),dir=process.env.DATA_DIR||path.join(root,'data');
mkdirSync(dir,{recursive:true});
const sqlite=new DatabaseSync(path.join(dir,'studio.db'));
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
// Upgrade the original local schema without losing accounts, sessions or attachments.
if(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()){
  sqlite.exec('BEGIN IMMEDIATE');
  try{
    for(const name of ['users','sessions','items','images','settings'])sqlite.exec(`ALTER TABLE ${name} RENAME TO studio_${name}`);
    sqlite.exec("ALTER TABLE studio_users ADD COLUMN created TEXT NOT NULL DEFAULT ''; ALTER TABLE studio_items ADD COLUMN mutation TEXT NOT NULL DEFAULT ''; ALTER TABLE studio_images ADD COLUMN size INTEGER NOT NULL DEFAULT 0; CREATE TABLE studio_image_data(id TEXT PRIMARY KEY REFERENCES studio_images(id) ON DELETE CASCADE,data TEXT NOT NULL);");
    for(const img of sqlite.prepare('SELECT id,bytes FROM studio_images').all()){
      sqlite.prepare('INSERT INTO studio_image_data VALUES(?,?)').run(img.id,Buffer.from(img.bytes).toString('base64'));
      sqlite.prepare('UPDATE studio_images SET size=? WHERE id=?').run(img.bytes.length,img.id);
    }
    sqlite.exec('ALTER TABLE studio_images DROP COLUMN bytes;');
    sqlite.exec('COMMIT');
  }catch(e){sqlite.exec('ROLLBACK');throw e;}
}
sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY);');
for(const name of readdirSync(path.join(root,'cloudflare/site/migrations/studio')).sort()){
  if(!sqlite.prepare('SELECT name FROM local_migrations WHERE name=?').get(name)){
    sqlite.exec('BEGIN IMMEDIATE');try{sqlite.exec(readFileSync(path.join(root,'cloudflare/site/migrations/studio',name),'utf8'));sqlite.prepare('INSERT INTO local_migrations VALUES(?)').run(name);sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
}
function statement(sql){let values=[];return {bind(...args){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values)||null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)},results:[]};},execute(){return {results:sqlite.prepare(sql).all(...values)};}};}
const db={prepare:statement,async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const server=http.createServer(async(req,res)=>{
 try{
 const origin=`${req.headers['x-forwarded-proto']==='https'||process.env.COOKIE_SECURE==='1'?'https':'http'}://${req.headers.host}`,url=new URL(req.url,origin);
 if(url.pathname.startsWith('/api/')){
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>12*1024*1024){res.writeHead(413);res.end('{"error":"请求过大"}');return;}chunks.push(chunk);}
   const request=new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
   const response=await onRequest({request,env:{STUDIO_DB:db,STUDIO_AUTH_SECRET:'local-development-secret-not-used-for-scrypt',LOCAL_MODE:true,LOCAL_VERIFY:(password,user)=>timingSafeEqual(scryptSync(password,user.salt,64),Buffer.from(user.password,'hex'))}});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
 }
 const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};const file=files[url.pathname];
 if(!file||req.method!=='GET'){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(readFileSync(path.join(root,'public',file[0])));
 }catch(e){console.error(e);res.writeHead(500);res.end('{"error":"服务暂时无法处理请求"}');}
});
server.listen(Number(process.env.PORT||3210),process.env.HOST||'127.0.0.1',()=>console.log(`CKUN STUDIO: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3210}`));
