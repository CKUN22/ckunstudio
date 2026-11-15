const encoder=new TextEncoder();
const problem=(status,message)=>{throw Object.assign(new Error(message),{status});};
async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
async function mac(env,value){const key=await crypto.subtle.importKey('raw',encoder.encode(env.STUDIO_AUTH_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0;};
async function binding(env,request){return mac(env,(request.headers.get('CF-Connecting-IP')||'local')+':'+(request.headers.get('user-agent')||'').slice(0,200));}
async function sign(env,payload){const body=btoa(JSON.stringify(payload));return body+'.'+await mac(env,body);}
async function decode(env,token){
 if(typeof token!=='string'||token.length>4096)problem(403,'验证已失效，请重新验证');
 const [body,signature]=token.split('.');if(!equal(signature,await mac(env,body)))problem(403,'验证无效');
 let value;try{value=JSON.parse(atob(body));}catch{problem(403,'验证无效');}
 if(!Number.isFinite(value.expires)||value.expires<Date.now())problem(403,'验证已过期，请重新验证');return value;
}
export async function verificationSettings(db,env){
 const row=await db.prepare("SELECT value FROM studio_settings WHERE key='site_verification'").first();
 let saved={};try{saved=JSON.parse(row?.value||'{}');}catch{}
 return {mode:['auto','manual','turnstile','off'].includes(saved.mode)?saved.mode:(['auto','manual','turnstile','off'].includes(env.SITE_VERIFICATION_DEFAULT_MODE)?env.SITE_VERIFICATION_DEFAULT_MODE:env.LOCAL_MODE?'off':'auto'),protectSite:saved.protectSite!==false,siteKey:env.TURNSTILE_SITE_KEY||'',turnstileConfigured:!!(env.TURNSTILE_SITE_KEY&&env.TURNSTILE_SECRET_KEY)};
}
export async function hasClearance(env,request){
 const token=/(?:^|;\s*)ckun_clearance=([^;]+)/.exec(request.headers.get('cookie')||'')?.[1];
 if(!token)return false;try{const value=await decode(env,token);return value.type==='clearance'&&equal(value.binding,await binding(env,request));}catch{return false;}
}
async function manualCode(env,id){const value=await mac(env,'captcha:'+id);return Array.from({length:6},(_,i)=>'23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[parseInt(value.slice(i*2,i*2+2),16)%31]).join('');}
export async function makeChallenge(db,env,request){
 const settings=await verificationSettings(db,env),mode=new URL(request.url).searchParams.get('mode')==='manual'&&settings.mode==='auto'?'manual':settings.mode;
 if(mode==='off')return {mode};
 if(mode==='turnstile'){
  if(!settings.turnstileConfigured)problem(503,'网站验证尚未完成配置，请联系管理员');
  return {mode,siteKey:settings.siteKey};
 }
 const id=crypto.randomUUID(),expires=Date.now()+300000,payload={id,mode,expires,type:'challenge',binding:await binding(env,request)},token=await sign(env,payload);
 if(mode==='auto')return {mode,token,prefix:id,difficulty:4};
 const code=await manualCode(env,id);
 const noise=Array.from(crypto.getRandomValues(new Uint8Array(32)));
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="86" viewBox="0 0 260 86"><rect width="260" height="86" fill="#eff5f0"/>${noise.slice(0,10).map((n,i)=>`<path d="M0 ${n%86}Q${n} ${noise[i+10]%86} 260 ${noise[i+20]%86}" stroke="#a4b9aa" fill="none"/>`).join('')}${code.split('').map((c,i)=>`<text x="${20+i*38}" y="${54+noise[i]%12}" transform="rotate(${noise[i]%25-12} ${20+i*38} 48)" font-family="monospace" font-weight="bold" font-size="32" fill="#294b37">${c}</text>`).join('')}</svg>`;
 return {mode,token,image:'data:image/svg+xml;base64,'+btoa(svg)};
}
export async function solveChallenge(db,env,request,data){
 const settings=await verificationSettings(db,env);
 if(settings.mode==='off')return clearance(env,request);
 if(settings.mode==='turnstile'){
  if(!settings.turnstileConfigured)problem(503,'网站验证尚未完成配置');
  if(typeof data.turnstileToken!=='string'||data.turnstileToken.length>2048)problem(400,'请完成人机验证');
  let result;try{const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret:env.TURNSTILE_SECRET_KEY,response:data.turnstileToken,remoteip:request.headers.get('CF-Connecting-IP')||''}),signal:AbortSignal.timeout(10000)});result=await response.json();}catch{problem(503,'验证服务暂时不可用，请稍后重试');}
  if(!result.success||result.hostname!==new URL(request.url).hostname||result.action!=='site-access')problem(403,'人机验证未通过，请重试');
 }else{
  const value=await decode(env,data.token);
  if(value.type!=='challenge'||!equal(value.binding,await binding(env,request))||!(value.mode===settings.mode||(settings.mode==='auto'&&value.mode==='manual')))problem(403,'验证信息不匹配');
  if(value.mode==='manual'){
   if(typeof data.answer!=='string'||!equal(data.answer.trim().toUpperCase(),await manualCode(env,value.id)))problem(403,'验证码不正确');
  }else{
   if(!Number.isSafeInteger(data.nonce)||data.nonce<0||data.nonce>10000000||!(await digest(value.id+':'+data.nonce)).startsWith('0000'))problem(403,'浏览器验证未通过');
  }
  try{await db.prepare('INSERT INTO site_verification_uses(id,expires) VALUES(?,?)').bind(value.id,value.expires).run();}catch{problem(403,'验证已使用，请重新验证');}
  await db.prepare('DELETE FROM site_verification_uses WHERE expires<?').bind(Date.now()).run();
 }
 return clearance(env,request);
}
async function clearance(env,request){const token=await sign(env,{type:'clearance',binding:await binding(env,request),expires:Date.now()+12*3600000});return `ckun_clearance=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
export function verificationPage(){return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>访问验证 · CKUN</title><link rel="stylesheet" href="/ckunstudio/verify.css"></head><body><main><span class="eyebrow">CKUN · 访问保护</span><h1>稍等一下，正在验证浏览器</h1><p>完成验证后继续访问，12 小时内通常无需重复验证。</p><div id="verification-status" role="status">正在准备…</div><div id="verification-widget"></div><form id="manual-form" hidden><img id="captcha-image" alt="六位图形验证码"><label>输入图中的六位字符<input name="answer" autocomplete="off" maxlength="6" required></label><button>确认并继续</button></form><button id="manual-switch" type="button">改用手动验证码</button><button id="verification-retry" type="button">重新验证</button><p class="note">验证有助于减少简单自动脚本访问。请启用 JavaScript 和 Cookie。</p></main><script src="/ckunstudio/verify.js" defer></script></body></html>`,{status:403,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'X-Robots-Tag':'noindex, nofollow'}});}
