import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Provide the verified existing personal site checkout');
const config = {
  name: 'gerenzhan',
  pages_build_output_dir: './dist',
  compatibility_date: '2026-11-13',
  d1_databases: [{ binding: 'STUDIO_DB', database_name: 'ckunstudio', database_id: '1052e724-880f-4381-b36d-9861d722b9b1', migrations_dir: 'migrations/studio' }],
  r2_buckets: [{ binding: 'STUDIO_IMAGES', bucket_name: 'ckunstudio-images' }]
};
const configPath = path.join(target, 'wrangler.jsonc');
let exists = false; try { await access(configPath); exists = true; } catch {}
if (exists) {
  const existing = JSON.parse(await readFile(configPath, 'utf8'));
  if (existing.name !== config.name || existing.d1_databases?.[0]?.database_id !== config.d1_databases[0].database_id) throw new Error('Existing production config differs; review before changing');
  if (existing.account_id) { delete existing.account_id; await writeFile(configPath, JSON.stringify(existing, null, 2) + '\n'); }
} else await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });

const secretPath = path.join(target, '.env.ckunstudio.production');
let secrets;
try { secrets = Object.fromEntries((await readFile(secretPath, 'utf8')).trim().split('\n').map(line => line.split('='))); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = { STUDIO_AUTH_SECRET: randomBytes(48).toString('hex'), STUDIO_SETUP_KEY: randomBytes(24).toString('hex') };
  await writeFile(secretPath, Object.entries(secrets).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
}
const wrangler = path.resolve(here, '../node_modules/wrangler/bin/wrangler.js');
for (const name of ['STUDIO_AUTH_SECRET', 'STUDIO_SETUP_KEY']) {
  if (!secrets[name] || secrets[name].length < 32) throw new Error('Local secret file is invalid');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, 'pages', 'secret', 'put', name, '--project-name', 'gerenzhan'], { cwd: target, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(output.replaceAll(secrets[name], '[REDACTED]'))));
    child.stdin.end(secrets[name] + '\n');
  });
  console.log(`${name}: configured (value not printed)`);
}
console.log('Production config saved. Initial setup key is in the Git-ignored .env.ckunstudio.production file.');
