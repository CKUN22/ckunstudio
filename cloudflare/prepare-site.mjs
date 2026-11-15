import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const revision = value => createHash('sha256').update(value).digest('hex').slice(0,12);
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const staged = path.join(here, 'site');
const destination = process.argv[2] && path.resolve(process.argv[2]);
const assets = path.join(staged, 'public', 'ckunstudio');
await mkdir(assets, { recursive: true });
await cp(path.join(staged,'lib/task-catalog.mjs'),path.join(appRoot,'public/task-catalog.js'));
await cp(path.join(staged,'lib/task-catalog.mjs'),path.join(assets,'task-catalog.js'));
let js = await readFile(path.join(appRoot, 'public/app.js'), 'utf8');
const readerExpression = 'files.map(f=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error(\'图片读取失败\'));reader.readAsDataURL(f);}))';
if (!js.includes(readerExpression)) throw new Error('Upload code changed; review cloud image preprocessing');
js = js.replace(readerExpression, 'files.map(prepareImage)');
js = (await readFile(path.join(here, 'image-upload.js'), 'utf8')) + '\n' + js;
js = js.replace('最多 5 张，总大小不超过 8MB', '最多 5 张，每张 512KB；大图自动压缩');
js = js.replaceAll('/api/', '/ckunstudio/api/');
const catalogHash=revision(await readFile(path.join(staged,'lib/task-catalog.mjs')));
js=js.replace("'./task-catalog.js'","'./task-catalog.js?v="+catalogHash+"'");
js = js.replace("authMode='login', refreshTimer", "authMode='login', setupKeyRequired=false, refreshTimer");
js = js.replace("if(setup.needsSetup){authMode='setup';", "if(setup.needsSetup){setupKeyRequired=setup.setupKeyRequired===true;authMode='setup';");
js = js.replace('<div id="auth-error"', '${setup&&setupKeyRequired?\'<label class="field">团队初始化密钥<input name="setupKey" type="password" required autocomplete="off" placeholder="由网站管理员在 Cloudflare 设置"></label>\':\'\'}<div id="auth-error"');
js = js.replace('首次启动，请创建你的账号。', '首次启动，请使用管理员密钥创建团队。');
js = js.replaceAll('Studio Flow', 'CKUN STUDIO');
js = js.replace('<div class="workspace">团队工作空间</div>', '<div class="workspace">团队工作空间 · <a href="/">返回首页 ↗</a></div>');
await writeFile(path.join(assets, 'app.js'), js);
let html = await readFile(path.join(appRoot, 'public/index.html'), 'utf8');
const styleHash=revision(await readFile(path.join(appRoot,'public/style.css')));
html = html.replace('/style.css', '/ckunstudio/style.css?v='+styleHash).replace('/app.js', '/ckunstudio/app.js?v='+revision(js)).replace('Studio Flow · 团队协作', 'CKUN STUDIO · 团队协作').replace('<title>', '<meta name="robots" content="noindex,nofollow"><title>');
await writeFile(path.join(assets, 'index.html'), html);
await cp(path.join(appRoot, 'public/style.css'), path.join(assets, 'style.css'));

if (destination) {
  // Copy only the integration's named paths. Preserve the rest of the personal site.
  for (const relative of ['functions/ckunstudio', 'functions/_middleware.js', 'functions/admin', 'lib', 'migrations/studio', 'public/ckunstudio', 'public/admin']) {
    await cp(path.join(staged, relative), path.join(destination, relative), { recursive: true });
  }
  for (const name of ['_headers', '_routes.json']) {
    const target = path.join(destination, 'public', name);
    let exists = false; try { await access(target); exists = true; } catch {}
    if (exists && await readFile(target, 'utf8') !== await readFile(path.join(staged, 'public', name), 'utf8')) {
      const previous=name==='_routes.json'?JSON.parse(await readFile(target,'utf8')):null;
      const safeHeaderAppend=name==='_headers'&&(await readFile(path.join(staged,'public',name),'utf8')).startsWith((await readFile(target,'utf8')).trimEnd());
      if(!safeHeaderAppend&&(!previous||previous.version!==1||JSON.stringify(previous.include)!==JSON.stringify(['/ckunstudio/api/*'])||previous.exclude?.length))throw new Error(`Review existing public/${name} before merging`);
    }
    await cp(path.join(staged, 'public', name), target);
  }
  await cp(path.join(staged, 'wrangler.studio.local.jsonc'), path.join(destination, 'wrangler.studio.local.jsonc'));
  const studioPage = path.join(destination, 'src/pages/CK_STUDIO.astro');
  const studioSource = await readFile(studioPage, 'utf8');
  const cleanStudio = studioSource.replace(/<a\b[^>]*href=["']\/ckunstudio\/?["'][^>]*>[\s\S]*?<\/a>/g, '');
  if(cleanStudio!==studioSource)await writeFile(studioPage,cleanStudio);
  const homePage=path.join(destination,'src/pages/index.astro');
  let homeSource=await readFile(homePage,'utf8');
  if(!homeSource.includes('data-studio-entry')){
    const aboutLink=/(<a class="btn btn-outline" href="\/about\/">[\s\S]*?<\/a>)/;
    if(!aboutLink.test(homeSource))throw new Error('Homepage hero changed; review the studio entry placement');
    homeSource=homeSource.replace(aboutLink,`$1
        <a class="btn btn-outline" href="/ckunstudio/" data-studio-entry aria-label="进入 CKUN STUDIO 团队协作">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M8 4v16M12 9h5M12 13h5" /></svg>
          团队协作 <span aria-hidden="true">↗</span>
        </a>`);
    homeSource=homeSource.replace('.hero-cta {','.hero-cta {\n    display: flex;\n    justify-content: center;\n    flex-wrap: wrap;\n    gap: 12px;');
    await writeFile(homePage,homeSource);
  }
  let ignore = await readFile(path.join(destination, '.gitignore'), 'utf8');
  if (!ignore.includes('.wrangler/')) { ignore += '\n# Cloudflare local data and secrets\n.wrangler/\n.dev.vars\n.dev.vars.*\n'; await writeFile(path.join(destination, '.gitignore'), ignore); }
  await cp(path.join(here, 'DEPLOY.md'), path.join(destination, 'CKUNSTUDIO部署说明.md'));
  console.log('CKUN STUDIO integrated into: ' + destination);
} else console.log('Cloudflare assets prepared in cloudflare/site/public/ckunstudio');
