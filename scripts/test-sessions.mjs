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

const {
  createSession,
  loadSessions,
  getSession,
  findSessionByRestoreToken,
  ensureRestoreToken,
  deleteSession,
  flushSessions,
} = await import('../server/src/session');

const file = path.join(dataDir, 'sessions.json');

if (READ_MODE) {
  // Reader subprocess: only verify the restore path (fresh process, no
  // in-memory state).
  loadSessions();
  const found = findSessionByRestoreToken(process.env.SIREN_TEST_RESTORE_TOKEN || '');
  if (!found || found.token !== 'tok_abc') throw new Error('FAIL: session not restored');
  console.log('PASS: session restored from disk via restore token:', found.userName, found.serverUrl);
  process.exit(0);
}

// 1. Create a session and flush immediately (simulates quit before debounce).
const { session: created, replaced, restoreToken } = createSession({
  serverUrl: 'https://jellyfin.example.com',
  token: 'tok_abc',
  deviceId: 'dev-1',
  userId: 'user-1',
  userName: 'alice',
});
if (replaced.length !== 0) throw new Error('FAIL: fresh store should evict nothing');
if (typeof restoreToken !== 'string' || restoreToken.length < 32) {
  throw new Error('FAIL: missing restore token');
}
if (findSessionByRestoreToken(restoreToken)?.id !== created.id) {
  throw new Error('FAIL: restore token does not resolve to the session');
}
if (findSessionByRestoreToken('not-the-token') !== null) {
  throw new Error('FAIL: invalid restore token must not resolve');
}

// 1b. Legacy rows (created before restore tokens) get one minted on demand.
const legacy = createSession({
  serverUrl: 'https://jellyfin.example.com',
  token: 'tok_legacy',
  deviceId: 'dev-legacy',
  userId: 'user-2',
  userName: 'bob',
});
if (ensureRestoreToken(legacy.session) !== null) {
  throw new Error('FAIL: a session with a hash must not mint a second token');
}
delete legacy.session.restoreHash;
const minted = ensureRestoreToken(legacy.session);
if (!minted) throw new Error('FAIL: legacy session did not mint a restore token');
if (findSessionByRestoreToken(minted)?.id !== legacy.session.id) {
  throw new Error('FAIL: minted token does not resolve');
}
deleteSession(legacy.session.id);
if (findSessionByRestoreToken(minted) !== null) {
  throw new Error('FAIL: deleted session still restores');
}
console.log('PASS: legacy session minted a restore token, logout revokes it');

flushSessions();

if (!fs.existsSync(file)) throw new Error('FAIL: sessions.json not written');
console.log('PASS: session persisted to', file);
console.log('file mode bits (POSIX only):', (fs.statSync(file).mode & 0o777).toString(8));

// The raw token must never hit disk; only its hash.
const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!persisted.sessions[0]?.restoreHash) throw new Error('FAIL: restore hash not persisted');
if ('restoreToken' in (persisted.sessions[0] ?? {})) {
  throw new Error('FAIL: raw restore token leaked to disk');
}
console.log('PASS: only the restore token hash is persisted');

// 2. Fresh process restores from disk using the raw token.
const { spawnSync } = await import('child_process');
const tsxBin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);
const result = spawnSync(tsxBin, [fileURLToPath(import.meta.url), 'READ'], {
  env: { ...process.env, SIREN_TEST_RESTORE_TOKEN: restoreToken },
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
console.log(result.stdout.trim());
if (result.status !== 0) {
  console.error(result.stderr.trim());
  throw new Error('FAIL: reader process errored');
}

// 3. Expired sessions are pruned on load (30-day sliding TTL).
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
raw.sessions[0].createdAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
fs.writeFileSync(file, JSON.stringify(raw));
loadSessions();
if (getSession(created.id) !== null) throw new Error('FAIL: expired session survived');
if (findSessionByRestoreToken(restoreToken) !== null) {
  throw new Error('FAIL: expired session restored via token');
}
console.log('PASS: expired session pruned on load');

// 4. The absolute cap also blocks restore, even for a recently used row.
const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'));
raw2.sessions[0].createdAt = Date.now();
raw2.sessions[0].bornAt = Date.now() - 366 * 24 * 60 * 60 * 1000;
fs.writeFileSync(file, JSON.stringify(raw2));
loadSessions();
if (findSessionByRestoreToken(restoreToken) !== null) {
  throw new Error('FAIL: absolute-cap session restored via token');
}
console.log('PASS: absolute-cap session cannot be restored');

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('ALL SESSION TESTS PASSED');
process.exit(0);
