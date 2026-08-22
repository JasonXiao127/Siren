// Quick verification of session persistence: create → flush → restore in a
// fresh process → expiry pruning. Run with: npx tsx scripts/test-sessions.mjs
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const READ_MODE = process.argv[2] === 'READ';
// Reader must inspect the PARENT's data dir, not a fresh one.
const dataDir =
  READ_MODE && process.env.SIREN_DATA_DIR
    ? process.env.SIREN_DATA_DIR
    : fs.mkdtempSync(path.join(os.tmpdir(), 'siren-sessions-'));
if (!READ_MODE) {
  process.env.SIREN_DATA_DIR = dataDir;
}

const { createSession, loadSessions, getSession, flushSessions } = await import(
  '../server/src/session'
);

const file = path.join(dataDir, 'sessions.json');

if (READ_MODE) {
  // Reader subprocess: only verify the restore path.
  loadSessions();
  const found = getSession(process.env.SIREN_TEST_SESSION_ID || '');
  if (!found || found.token !== 'tok_abc') throw new Error('FAIL: session not restored');
  console.log('PASS: session restored from disk:', found.userName, found.serverUrl);
  process.exit(0);
}

// 1. Create a session and flush immediately (simulates quit before debounce).
const created = createSession({
  serverUrl: 'https://jellyfin.example.com',
  token: 'tok_abc',
  deviceId: 'dev-1',
  userId: 'user-1',
  userName: 'alice',
});
flushSessions();

if (!fs.existsSync(file)) throw new Error('FAIL: sessions.json not written');
console.log('PASS: session persisted to', file);
console.log('file mode bits (POSIX only):', (fs.statSync(file).mode & 0o777).toString(8));

// 2. Fresh process restores from disk.
const { spawnSync } = await import('child_process');
const tsxBin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);
const result = spawnSync(tsxBin, [fileURLToPath(import.meta.url), 'READ'], {
  env: { ...process.env, SIREN_TEST_SESSION_ID: created.id },
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
console.log(result.stdout.trim());
if (result.status !== 0) {
  console.error(result.stderr.trim());
  throw new Error('FAIL: reader process errored');
}

// 3. Expired sessions are pruned on load.
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
raw.sessions[0].createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days old
fs.writeFileSync(file, JSON.stringify(raw));
loadSessions();
if (getSession(created.id) !== null) throw new Error('FAIL: expired session survived');
console.log('PASS: expired session pruned on load');

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('ALL SESSION TESTS PASSED');
process.exit(0);
