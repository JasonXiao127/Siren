// Bundles the Electron main process and the server child into two
// self-contained CJS files.
//
// IMPORTANT INVARIANT: everything except `electron` is bundled into these
// files. The packaged app contains ONLY dist-electron/** and client/dist/**
// (see electron-builder.yml) — there are no runtime node_modules. If you ever
// add a dependency that esbuild cannot bundle (native modules like
// better-sqlite3 or sharp), you must add it to `external` here AND to
// asarUnpack in electron-builder.yml, or the packaged app will crash.

import { build, context } from 'esbuild';
import { createRequire } from 'module';
import { rmSync } from 'fs';

const require = createRequire(import.meta.url);
const { version: appVersion } = require('../package.json');

const watch = process.argv.includes('--watch');
const prod = !watch;

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  // Single source of truth for the version reported to Jellyfin.
  define: { 'process.env.SIREN_APP_VERSION': JSON.stringify(appVersion) },
  minify: prod,
  sourcemap: !prod,
  logLevel: 'info',
};

const entries = [
  { ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' },
  { ...common, entryPoints: ['server/src/child.ts'], outfile: 'dist-electron/server.cjs' },
];

if (watch) {
  const contexts = await Promise.all(entries.map((entry) => context(entry)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching for changes...');

  // Clean shutdown: close watch contexts on Ctrl+C (standalone use).
  process.on('SIGINT', () => {
    Promise.all(contexts.map((ctx) => ctx.dispose())).finally(() => process.exit(0));
  });
} else {
  // Production builds start from a clean slate: esbuild never deletes stale
  // outputs, so leftovers from dev/watch sessions (sourcemaps, removed
  // entries) would otherwise ship inside the packaged asar.
  rmSync('dist-electron', { recursive: true, force: true });
  await Promise.all(entries.map((entry) => build(entry)));
}
