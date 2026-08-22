// Development orchestrator.
//
//  1. Bundles electron/main.ts and server/src/child.ts with esbuild (watch)
//  2. Starts the Vite dev server (client workspace, port 5174, strictPort)
//  3. Once Vite responds, launches Electron with VITE_DEV_SERVER_URL set
//     - the embedded server child binds fixed port 5173 (Vite's /api proxy
//       target) in dev
//  4. Restarts Electron whenever either bundle rebuilds
//  5. Tears everything down on Ctrl+C

import { context } from 'esbuild';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = require('electron'); // path to the electron executable
const { version: appVersion } = require('../package.json');

const VITE_PORT = 5174;
const DEV_SERVER_URL = `http://localhost:${VITE_PORT}`;

const children = new Set();
let shuttingDown = false;
let electronProc = null;
let restarting = false;

function log(prefix, message) {
  console.log(`[${prefix}] ${message}`);
}

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.add(child);
  child.on('exit', (code) => children.delete(child));
  return child;
}

function pipeStdio(child, prefix) {
  const tag = (buf) =>
    buf
      .toString()
      .split('\n')
      .filter(Boolean)
      .forEach((line) => log(prefix, line));
  child.stdout.on('data', tag);
  child.stderr.on('data', tag);
}

function waitForUrl(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
        } else {
          setTimeout(attempt, 400);
        }
      });
    };
    attempt();
  });
}

const commonBuild = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  // Single source of truth for the version reported to Jellyfin.
  define: { 'process.env.SIREN_APP_VERSION': JSON.stringify(appVersion) },
  sourcemap: true,
  logLevel: 'silent',
};

let onRebuildCallback = () => {};
const rebuildPlugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) onRebuildCallback();
    });
  },
};

async function startElectron() {
  if (shuttingDown) return;
  electronProc = spawnChild(electronBinary, ['.'], {
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL, NODE_ENV: 'development' },
  });
  pipeStdio(electronProc, 'electron');
  electronProc.on('exit', (code) => {
    electronProc = null;
    // User closed the window — treat as "dev session over".
    if (!restarting && !shuttingDown) {
      log('dev', `Electron exited (code ${code}) — shutting down`);
      shutdown(0);
    }
  });
  log('dev', 'Electron started');
}

async function main() {
  // 1. Initial builds (must exist before Electron forks the server child).
  const mainCtx = await context({
    ...commonBuild,
    entryPoints: ['electron/main.ts'],
    outfile: 'dist-electron/main.cjs',
    plugins: [rebuildPlugin],
  });
  const serverCtx = await context({
    ...commonBuild,
    entryPoints: ['server/src/child.ts'],
    outfile: 'dist-electron/server.cjs',
    plugins: [rebuildPlugin],
  });
  await mainCtx.rebuild();
  await serverCtx.rebuild();
  await Promise.all([mainCtx.watch(), serverCtx.watch()]);
  log('esbuild', 'watching electron/main.ts + server/src/child.ts');

  // Debounced Electron restart on rebuild.
  let restartTimer = null;
  onRebuildCallback = () => {
    if (shuttingDown || !electronProc) return;
    clearTimeout(restartTimer);
    restartTimer =     setTimeout(async () => {
      restarting = true;
      log('dev', 'Bundle changed — restarting Electron');
      const proc = electronProc;
      killTree(proc);
      await new Promise((resolve) => {
        if (!proc || proc.exitCode !== null) return resolve();
        proc.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
      restarting = false;
      startElectron();
    }, 300);
  };

  // 2. Vite dev server. Spawned via cmd /c on Windows: avoids the DEP0190
  // deprecation (args + shell:true) while still resolving npm.cmd.
  const npmArgs =
    process.platform === 'win32'
      ? ['/c', 'npm', 'run', 'dev', '--workspace=@siren/client']
      : ['run', 'dev', '--workspace=@siren/client'];
  const vite = spawnChild(
    process.platform === 'win32' ? 'cmd.exe' : 'npm',
    npmArgs
  );
  pipeStdio(vite, 'vite');
  vite.on('exit', (code) => {
    if (!shuttingDown) {
      log('dev', `Vite exited unexpectedly (code ${code}) — shutting down`);
      shutdown(1);
    }
  });

  // 3. Wait for Vite, then launch Electron.
  await waitForUrl(DEV_SERVER_URL);
  log('vite', `ready at ${DEV_SERVER_URL}`);
  await startElectron();

  // Keep the process alive; children own the lifetime now.
  setInterval(() => {}, 1 << 30);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // child.kill() on Windows only terminates the direct process — a
    // shell:true spawn (npm.cmd → node/vite) leaves grandchildren running
    // and holding ports. taskkill /T takes the whole tree.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      killTree(child);
    } catch {
      // already gone
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error(err);
  shutdown(1);
});
