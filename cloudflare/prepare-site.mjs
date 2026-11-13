import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const staged = path.join(here, 'site');
const destination = process.argv[2] && path.resolve(process.argv[2]);
const assets = path.join(staged, 'public', 'ckunstudio');
await mkdir(assets, { recursive: true });
let js = await readFile(path.join(appRoot, 'public/app.js'), 'utf8');
const readerExpression = 'files.map(f=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error(\'图片读取失败\'));reader.readAsDataURL(f);}))';
if (!js.includes(readerExpression)) throw new Error('Upload code changed; review cloud image preprocessing');
js = js.replace(readerExpression, 'files.map(prepareImage)');
js = (await readFile(path.join(here, 'image-upload.js'), 'utf8')) + '\n' + js;
js = js.replace('最多 5 张，总大小不超过 8MB', '最多 5 张，每张 512KB；大图自动压缩');
js = js.replaceAll('/api/', '/ckunstudio/api/');
js = js.replace("authMode='login', refreshTimer", "authMode='login', setupKeyRequired=false, refreshTimer");
js = js.replace("if(setup.needsSetup){authMode='setup';", "if(setup.needsSetup){setupKeyRequired=setup.setupKeyRequired===true;authMode='setup';");
js = js.replace('<div id="auth-error"', '${setup&&setupKeyRequired?\'<label class="field">团队初始化密钥<input name="setupKey" type="password" required autocomplete="off" placeholder="由网站管理员在 Cloudflare 设置"></label>\':\'\'}<div id="auth-error"');
js = js.replace('首次启动，请创建你的账号。', '首次启动，请使用管理员密钥创建团队。');
js = js.replaceAll('Studio Flow', 'CKUN STUDIO');
js = js.replace('<div class="workspace">团队工作空间</div>', '<div class="workspace">团队工作空间 · <a href="/CK_STUDIO">返回官网 ↗</a></div>');
await writeFile(path.join(assets, 'app.js'), js);
let html = await readFile(path.join(appRoot, 'public/index.html'), 'utf8');
html = html.replace('/style.css', '/ckunstudio/style.css').replace('/app.js', '/ckunstudio/app.js').replace('Studio Flow · 团队协作', 'CKUN STUDIO · 团队协作').replace('<title>', '<meta name="robots" content="noindex,nofollow"><title>');
await writeFile(path.join(assets, 'index.html'), html);
await cp(path.join(appRoot, 'public/style.css'), path.join(assets, 'style.css'));

if (destination) {
  // Copy only the integration's named paths. Preserve the rest of the personal site.
  for (const relative of ['functions/ckunstudio', 'lib', 'migrations/studio', 'public/ckunstudio']) {
    await cp(path.join(staged, relative), path.join(destination, relative), { recursive: true });
  }
  for (const name of ['_headers', '_routes.json']) {
    const target = path.join(destination, 'public', name);
    let exists = false; try { await access(target); exists = true; } catch {}
    if (exists && await readFile(target, 'utf8') !== await readFile(path.join(staged, 'public', name), 'utf8')) throw new Error(`Review existing public/${name} before merging`);
    await cp(path.join(staged, 'public', name), target);
  }
  await cp(path.join(staged, 'wrangler.studio.local.jsonc'), path.join(destination, 'wrangler.studio.local.jsonc'));
  const studioPage = path.join(destination, 'src/pages/CK_STUDIO.astro');
  let source = await readFile(studioPage, 'utf8');
  if (!source.includes('href="/ckunstudio"')) {
    source = source.replace('<nav aria-label="工作室导航">', '<nav aria-label="工作室导航"><a href="/ckunstudio">团队协作 <span aria-hidden="true">↗</span></a>');
    await writeFile(studioPage, source);
  }
  let ignore = await readFile(path.join(destination, '.gitignore'), 'utf8');
  if (!ignore.includes('.wrangler/')) { ignore += '\n# Cloudflare local data and secrets\n.wrangler/\n.dev.vars\n.dev.vars.*\n'; await writeFile(path.join(destination, '.gitignore'), ignore); }
  await cp(path.join(here, 'DEPLOY.md'), path.join(destination, 'CKUNSTUDIO部署说明.md'));
  console.log('CKUN STUDIO integrated into: ' + destination);
} else console.log('Cloudflare assets prepared in cloudflare/site/public/ckunstudio');
