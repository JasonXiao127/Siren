// Parallel dev: web archive (Siren.WebArchive, 5174/5173) + combined (., 5177/5176).
// Usage: npm run dev:both  (from combined repo root; ../Siren.WebArchive must exist)
// Web leads UI — build features there first, then port the hunk to Client.
// Kill with Ctrl+C: both trees are torn down.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const webRoot = path.resolve(clientRoot, '..', 'Siren.WebArchive');

if (!fs.existsSync(path.join(webRoot, 'package.json'))) {
  console.error(`[dev:both] Web repo not found at ${webRoot}`);
  process.exit(1);
}

const children = new Set();
let shuttingDown = false;

function run(label, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  children.add(child);
  child.on('exit', (code) => {
    children.delete(child);
    if (!shuttingDown) console.log(`[dev:both] ${label} exited (code ${code})`);
  });
  child.stdout.on('data', (b) => b.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${label}] ${l}`)));
  child.stderr.on('data', (b) => b.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${label}] ${l}`)));
  return child;
}

console.log('[dev:both] web      → http://localhost:5174 (api 5173)');
console.log('[dev:both] desktop  → Electron on http://localhost:5177 (api 5176)');
run('web', 'npm', ['run', 'dev'], webRoot);
run('desktop', 'node', ['scripts/dev.mjs'], clientRoot);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch { /* gone */ }
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
