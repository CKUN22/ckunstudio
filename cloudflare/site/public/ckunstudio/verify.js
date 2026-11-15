let generation=0,widget;
const status=document.querySelector('#verification-status'),form=document.querySelector('#manual-form');
async function request(path,body){const response=await fetch('/ckunstudio/api/verification'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error||'验证失败');return data;}
async function submit(body){status.textContent='正在确认…';await request('',body);location.reload();}
async function start(mode=''){
 const current=++generation;form.hidden=true;status.textContent='正在验证，请稍候…';
 try{
  const challenge=await request(mode?'?mode='+mode:'');if(current!==generation)return;
  document.querySelector('#manual-switch').hidden=!['auto','manual'].includes(challenge.mode);
  if(challenge.mode==='off'){await submit({});return;}
  if(challenge.mode==='manual'){
   status.textContent='请输入图中的字符，不区分大小写。';form.hidden=false;document.querySelector('#captcha-image').src=challenge.image;
   form.onsubmit=async e=>{e.preventDefault();try{await submit({token:challenge.token,answer:new FormData(form).get('answer')});}catch(e){status.textContent=e.message;}};return;
  }
  if(challenge.mode==='turnstile'){
   if(!window.turnstile){await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.onload=resolve;script.onerror=()=>reject(new Error('人机验证无法加载，请检查网络后重试'));document.head.append(script);});}
   if(current!==generation)return;if(widget!==undefined)window.turnstile.remove(widget);
   widget=window.turnstile.render('#verification-widget',{sitekey:challenge.siteKey,action:'site-access',callback:token=>submit({turnstileToken:token}).catch(e=>{status.textContent=e.message;window.turnstile.reset(widget);}),'error-callback':()=>{status.textContent='验证暂时不可用，请重试';},'expired-callback':()=>window.turnstile.reset(widget)});return;
  }
  const encoder=new TextEncoder();
  for(let start=0;start<10000000;start+=128){
   if(current!==generation)return;
   const hashes=await Promise.all(Array.from({length:128},(_,i)=>crypto.subtle.digest('SHA-256',encoder.encode(challenge.prefix+':'+(start+i)))));
   const found=hashes.findIndex(hash=>{const b=new Uint8Array(hash);return b[0]===0&&b[1]===0;});
   if(found>=0){await submit({token:challenge.token,nonce:start+found});return;}
   if(start%4096===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  throw new Error('自动验证未完成，请使用手动验证码');
 }catch(e){if(current===generation)status.textContent=e.message;}
}
document.querySelector('#manual-switch').onclick=()=>start('manual');document.querySelector('#verification-retry').onclick=()=>start();start();
