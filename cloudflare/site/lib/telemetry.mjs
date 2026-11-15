const encode = new TextEncoder();
export const chinaDay = (now = Date.now()) => new Date(now + 28800000).toISOString().slice(0,10);
export function blockedRequest(request) {
 let path; try { path = decodeURIComponent(new URL(request.url).pathname); } catch { return 'invalid-path'; }
 if (path.includes('\\') || path.includes('\0') || /(?:^|\/)\.(?:env|git|svn|aws)(?:[/.]|$)|\.(?:sqlite3?|db|pem|key|bak|dump)(?:$|\/)|(?:^|\/)(?:wp-admin|wp-login\.php|xmlrpc\.php)(?:$|\/)/i.test(path)) return 'sensitive-path-probe';
 if (['TRACE','CONNECT','TRACK'].includes(request.method)) return 'unsafe-method';
 return '';
}
function normalizedPath(url) {
 return url.pathname.slice(0,240).replace(/[a-f0-9]{32,64}/gi,':id');
}
export async function recordTraffic({request,env}, response, started = Date.now(), reason = '') {
 if (!env.STUDIO_DB || !env.STUDIO_AUTH_SECRET) return;
 const url = new URL(request.url);
 if (url.pathname==='/admin'||url.pathname.startsWith('/admin/')||url.pathname.includes('/api/admin/')) return;
 // Successful background sync and cached avatar reads must not amplify D1 writes.
 if(request.method==='GET'&&response.status<400&&/\/api\/(?:items|users|notifications|me|setup|avatars(?:\/[^/]+)?)$/.test(url.pathname))return; // Reading reports must not change the reports.
 const day = chinaDay(), path = normalizedPath(url), studio = /^\/ckunstudio(?:\/|$)/.test(path) || env.LOCAL_MODE;
 const scopes = ['all',studio?'studio':'site'];
 const ua = request.headers.get('user-agent') || '', bot = /bot|crawler|spider|headless|curl|wget|python|httpclient/i.test(ua);
 const page = request.method==='GET' && response.status===200 && (response.headers.get('content-type')||'').includes('text/html') && !bot;
 const elapsed = Math.max(0,Date.now()-started), bytes = Number(response.headers.get('content-length')||0);
 const hour = new Date(Date.now()+28800000).toISOString().slice(11,13);
 const device = /ipad|tablet/i.test(ua)?'平板':/mobile|android|iphone/i.test(ua)?'手机':'桌面 / 其他';
 const browser = /Edg\//.test(ua)?'Edge':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'其他';
 const os = /Windows/i.test(ua)?'Windows':/Android/i.test(ua)?'Android':/iPhone|iPad/i.test(ua)?'iOS':/Macintosh/i.test(ua)?'macOS':/Linux/i.test(ua)?'Linux':'其他';
 let referrer='直接访问';try {const ref=new URL(request.headers.get('referer'));referrer=ref.origin===url.origin?'站内访问':ref.hostname.slice(0,120);}catch{}
 const dimensions = [['total','all'],['hour',hour],['status',String(response.status)]];
 if(page)dimensions.push(['path',path],['country',String(request.cf?.country||'未知').slice(0,5)],['device',device],['browser',browser],['os',os],['referrer',referrer]);
 const db = env.STUDIO_DB, statements=[];
 let visitor;
 if(page){
  const key=await crypto.subtle.importKey('raw',encode.encode(env.STUDIO_AUTH_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,encode.encode(`${day}:${request.headers.get('CF-Connecting-IP')||'local'}:${ua.slice(0,300)}`));
  visitor=Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('');
 }
 for(const scope of scopes){
  for(const [dimension,value] of dimensions)statements.push(db.prepare(`INSERT INTO site_metrics(day,scope,dimension,value,requests,pages,bots,errors,duration_ms,bytes) VALUES(?,?,?,?,1,?,?,?,?,?) ON CONFLICT(day,scope,dimension,value) DO UPDATE SET requests=requests+1,pages=pages+excluded.pages,bots=bots+excluded.bots,errors=errors+excluded.errors,duration_ms=duration_ms+excluded.duration_ms,bytes=bytes+excluded.bytes`).bind(day,scope,dimension,value,Number(page),Number(bot),Number(response.status>=400),elapsed,Number.isFinite(bytes)?bytes:0));
  if(visitor)statements.push(db.prepare('INSERT OR IGNORE INTO site_visitors(day,scope,visitor) VALUES(?,?,?)').bind(day,scope,visitor));
  if(reason||response.status>=400){const event=reason||({401:'unauthenticated',403:'forbidden',429:'rate-limited'}[response.status]||'http-error');statements.push(db.prepare('INSERT INTO site_security(day,scope,reason,path,status,count,last_seen) VALUES(?,?,?,?,?,1,?) ON CONFLICT(day,scope,reason,path,status) DO UPDATE SET count=count+1,last_seen=excluded.last_seen').bind(day,scope,event,path,response.status,new Date().toISOString()));}
 }
 await db.batch(statements);
}
export async function trafficReport(db,url) {
 const end=url.searchParams.get('end')||chinaDay(),start=url.searchParams.get('start')||chinaDay(Date.now()-29*86400000),scope=url.searchParams.get('scope')||'all';
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||new Date(start).toISOString().slice(0,10)!==start||new Date(end).toISOString().slice(0,10)!==end||start>end||Date.parse(end)-Date.parse(start)>365*86400000||!['all','site','studio'].includes(scope))throw Object.assign(new Error('请选择有效日期，单次最多查询 366 天'),{status:400});
 const results=await db.batch([
  db.prepare(`SELECT m.day,m.requests,m.pages,m.bots,m.errors,m.duration_ms,m.bytes,(SELECT count(*) FROM site_visitors v WHERE v.day=m.day AND v.scope=m.scope) AS visitors FROM site_metrics m WHERE scope=? AND dimension='total' AND day BETWEEN ? AND ? ORDER BY day`).bind(scope,start,end),
  db.prepare(`SELECT dimension,value,SUM(requests) AS requests,SUM(pages) AS pages,SUM(errors) AS errors,SUM(bots) AS bots FROM site_metrics WHERE scope=? AND day BETWEEN ? AND ? AND dimension<>'total' GROUP BY dimension,value ORDER BY pages DESC,requests DESC LIMIT 500`).bind(scope,start,end),
  db.prepare('SELECT reason,path,status,SUM(count) AS count,MAX(last_seen) AS last_seen FROM site_security WHERE scope=? AND day BETWEEN ? AND ? GROUP BY reason,path,status ORDER BY count DESC LIMIT 100').bind(scope,start,end),
  db.prepare('SELECT MIN(day) AS first_day,MAX(day) AS last_day FROM site_metrics WHERE scope=?').bind(scope),
  db.prepare('SELECT day,failures FROM site_telemetry_failures WHERE day BETWEEN ? AND ? ORDER BY day').bind(start,end)
 ]);
 const business=await db.batch([
  db.prepare(`SELECT kind,CASE WHEN blocked_reason<>'' AND status<>'done' THEN 'blocked' ELSE status END AS status,COUNT(*) AS count FROM studio_items GROUP BY kind,CASE WHEN blocked_reason<>'' AND status<>'done' THEN 'blocked' ELSE status END`),
  db.prepare('SELECT COUNT(*) AS count FROM studio_users WHERE active=1'),
  db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM studio_images')
 ]);
 return {start,end,scope,timezone:'Asia/Shanghai',daily:results[0].results,dimensions:results[1].results,security:results[2].results,retention:results[3].results[0],collectionFailures:results[4].results,business:{items:business[0].results,members:business[1].results[0].count,attachments:business[2].results[0]},generatedAt:new Date().toISOString()};
}
export async function telemetryFailure(env){
 console.error('Traffic collection failed; inspect D1 availability and quotas');
 try{await env.STUDIO_DB.prepare('INSERT INTO site_telemetry_failures(day,failures) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET failures=failures+1').bind(chinaDay()).run();}catch{}
}
