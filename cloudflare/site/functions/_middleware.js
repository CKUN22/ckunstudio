import {verificationSettings,hasClearance,verificationPage} from '../lib/verification.mjs';
import {blockedRequest,recordTraffic,telemetryFailure} from '../lib/telemetry.mjs';
const burstWindows=new Map();
function burstLimited(request){
 const now=Date.now(),key=request.headers.get('CF-Connecting-IP')||'local';
 let row=burstWindows.get(key);if(!row||row.expires<now){row={count:0,expires:now+60000};burstWindows.set(key,row);}
 row.count++;if(burstWindows.size>5000){for(const [id,value] of burstWindows)if(value.expires<now)burstWindows.delete(id);if(burstWindows.size>5000)burstWindows.delete(burstWindows.keys().next().value);}
 return row.count>120;
}
export async function onRequest(context){
 // Best-effort isolate burst brake: Cloudflare edge rate limits remain the authoritative DDoS control.
 if(burstLimited(context.request))return new Response('请求过于频繁，请稍后重试',{status:429,headers:{'Retry-After':'60','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 const started=Date.now(),reason=blockedRequest(context.request);
 let response;
 if(reason)response=new Response('Not found',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
 else {
  const url=new URL(context.request.url),isPage=['GET','HEAD'].includes(context.request.method)&&!url.pathname.includes('/api/')&&(!/\.[a-z0-9]{1,8}$/i.test(url.pathname)||(context.request.headers.get('accept')||'').includes('text/html'));
  let needsVerification=false;
  if(isPage&&context.env.STUDIO_DB&&context.env.STUDIO_AUTH_SECRET){
   try{const settings=await verificationSettings(context.env.STUDIO_DB,context.env);needsVerification=(settings.protectSite||url.pathname==='/ckunstudio/verify/'||url.pathname==='/admin/verify/')&&settings.mode!=='off'&&!await hasClearance(context.env,context.request);}catch{return new Response('访问保护暂时不可用，请稍后重试',{status:503,headers:{'Cache-Control':'no-store'}});}
  }
  if(needsVerification){response=verificationPage();context.data.verificationChallenge=true;}
  else if(url.pathname==='/admin/verify/')response=Response.redirect(url.origin+'/admin/',303);
  else if(url.pathname==='/ckunstudio/verify/')response=Response.redirect(url.origin+'/ckunstudio/',303);
  else response=await context.next();
 }
 const headers=new Headers(response.headers);
 headers.set('X-Content-Type-Options','nosniff');headers.set('X-Frame-Options','DENY');
 headers.set('Referrer-Policy','strict-origin-when-cross-origin');
 headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 if(new URL(context.request.url).protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000');
 if(!context.data.verificationChallenge&&(/^\/(?:ckunstudio|admin)(?:\/|$)/.test(new URL(context.request.url).pathname)))headers.set('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
 response=new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 const work=recordTraffic(context,response,started,reason||(context.data.verificationChallenge?'verification-required':'')).catch(()=>telemetryFailure(context.env));
 if(context.waitUntil)context.waitUntil(work);else await work;
 return response;
}
