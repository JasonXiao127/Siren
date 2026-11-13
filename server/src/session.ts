import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface Session {
  id: string;
  serverUrl: string;
  token: string;
  deviceId: string;
  userId: string;
  userName: string;
  createdAt: number;
  /** First creation time for the absolute lifetime cap (never slides). */
  bornAt: number;
  /**
   * SHA-256 (hex) of the per-device restore token. The raw token lives only
   * in the client's localStorage, so a browser that drops the session cookie
   * on exit can silently trade it for a fresh cookie instead of showing the
   * login form. Optional: rows persisted by older releases have no token and
   * simply require a normal login once.
   */
  restoreHash?: string;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days sliding
export const SESSION_ABSOLUTE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year absolute max
export const MAX_SESSIONS_PER_USER = 10;
export const SESSION_COOKIE_NAME = 'siren-session';
const MAX_RESTORE_TOKEN_LENGTH = 128;

const sessions = new Map<string, Session>();

// Domain-separated so the token hash can never collide with another SHA-256
// use in the app.
const RESTORE_TOKEN_PREFIX = 'siren-restore-v1:';

export function hashRestoreToken(token: string): string {
  return crypto.createHash('sha256').update(RESTORE_TOKEN_PREFIX + token).digest('hex');
}

// ---------------------------------------------------------------------------
// Disk persistence
//
// Sessions survive app restarts by persisting to a JSON file inside
// SIREN_DATA_DIR (Electron: userData, set by the main process;
// Docker: /data volume; default ./data, cwd-dependent and ephemeral).
// Writes are debounced and atomic (tmp + rename); the file holds auth tokens
// so it is created with mode 0600.
//
// Paths are resolved lazily (not at module top-level) so bundling and test
// env mutation after import can't produce load-order bugs.
// ---------------------------------------------------------------------------

function getDataDir(): string {
  return process.env.SIREN_DATA_DIR || path.join(process.cwd(), 'data');
}

function getSessionsFile(): string {
  return path.join(getDataDir(), 'sessions.json');
}

let saveTimer: NodeJS.Timeout | null = null;
let dirty = false;

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS || now - session.bornAt > SESSION_ABSOLUTE_TTL_MS) {
      sessions.delete(id);
      dirty = true;
    }
  }
}

function serialize(): string {
  return JSON.stringify({ version: 1, sessions: Array.from(sessions.values()) });
}

/** Atomic write: tmp file + rename so a crash never leaves a truncated store. */
function writeFileAtomic(content: string): void {
  const dataDir = getDataDir();
  const sessionsFile = getSessionsFile();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${sessionsFile}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    // mode only applies at creation; a stale tmp from a crashed write keeps
    // old perms — enforce before rename.
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  fs.renameSync(tmp, sessionsFile);
}

function scheduleSave(): void {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      writeFileAtomic(serialize());
    } catch (err) {
      console.error('[siren] Failed to persist sessions:', err);
    }
  }, 500);
  // Don't keep the process alive just for the debounce timer.
  saveTimer.unref?.();
}

/**
 * Older releases persisted sessions without the fields the proxy now requires
 * (notably `deviceId`). Loading one of those would throw while building the
 * Jellyfin Authorization header, killing the request mid-flight. Reject the
 * whole row instead so the browser gets a clean 401 and can re-login.
 */
export function isUsableSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<Session>;
  return (
    typeof session.id === 'string' &&
    session.id.length > 0 &&
    typeof session.serverUrl === 'string' &&
    session.serverUrl.length > 0 &&
    typeof session.token === 'string' &&
    session.token.length > 0 &&
    typeof session.deviceId === 'string' &&
    session.deviceId.length > 0 &&
    typeof session.userId === 'string' &&
    session.userId.length > 0 &&
    typeof session.userName === 'string' &&
    session.userName.length > 0 &&
    typeof session.createdAt === 'number'
  );
}

/** Loads persisted sessions at startup, pruning expired entries. */
export function loadSessions(): void {
  const sessionsFile = getSessionsFile();
  try {
    const raw = fs.readFileSync(sessionsFile, 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; sessions?: Session[] };
    let dropped = 0;
    for (const session of parsed.sessions ?? []) {
      if (!isUsableSession(session)) {
        dropped++;
        continue;
      }
      // Migrate pre-bornAt rows: absolute lifetime starts at createdAt.
      if (typeof session.bornAt !== 'number') {
        session.bornAt = session.createdAt;
      }
      sessions.set(session.id, session);
    }
    if (dropped > 0) {
      console.warn(
        `[siren] Dropped ${dropped} invalid persisted session(s); affected clients must sign in again`
      );
      scheduleSave();
    }
    pruneExpired();
  } catch (err) {
    // Missing file — start clean. Corrupt file — back up for forensics
    // instead of silently wiping.
    try {
      const stat = fs.statSync(sessionsFile);
      if (stat.isFile()) {
        const backup = `${sessionsFile}.corrupt-${Date.now()}`;
        fs.copyFileSync(sessionsFile, backup);
        console.error(`[siren] sessions.json corrupt, backed up to ${backup}`);
      }
    } catch {
      // Missing or backup failed — start with a clean slate.
    }
    void err;
  }
}

/**
 * Synchronously persists pending changes. Called on graceful shutdown
 * (before-quit → child 'quit' message) so the most recent login is never lost
 * to the write-behind debounce window.
 */
export function flushSessions(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  try {
    writeFileAtomic(serialize());
  } catch (err) {
    console.error('[siren] Failed to flush sessions:', err);
  }
}

export function getSession(id: string): Session | null {
  const session = sessions.get(id);
  if (!isUsableSession(session)) {
    if (session) {
      // A malformed row inserted by an older build or a manual edit.
      sessions.delete(id);
      scheduleSave();
    }
    return null;
  }
  const now = Date.now();
  if (now - session.createdAt > SESSION_TTL_MS || now - session.bornAt > SESSION_ABSOLUTE_TTL_MS) {
    sessions.delete(id);
    scheduleSave();
    return null;
  }
  // Sliding renewal: active users don't get logged out mid-use. Refresh at
  // most once per day to avoid a disk write on every request. bornAt never
  // slides, enforcing the absolute cap.
  if (now - session.createdAt > 24 * 60 * 60 * 1000) {
    session.createdAt = now;
    scheduleSave();
  }
  return session;
}

export interface CreateSessionResult {
  session: Session;
  /** Older rows evicted by this login (same device + LRU overflow) — caller should revoke their Jellyfin tokens. */
  replaced: Session[];
  /** Raw per-device restore token; only its SHA-256 is persisted. */
  restoreToken: string;
}

export function createSession(data: Omit<Session, 'id' | 'createdAt' | 'bornAt' | 'restoreHash'>): CreateSessionResult {
  const replaced: Session[] = [];
  // Replace any previous session for the same device identity so repeated
  // logins don't accumulate rows with live tokens until TTL. Keyed on
  // (serverUrl, userId, deviceId) so a second device doesn't kill the first.
  for (const [id, existing] of sessions) {
    if (
      existing.serverUrl === data.serverUrl &&
      existing.userId === data.userId &&
      existing.deviceId === data.deviceId
    ) {
      replaced.push(existing);
      sessions.delete(id);
      dirty = true;
    }
  }

  const now = Date.now();
  const restoreToken = crypto.randomBytes(32).toString('base64url');
  const session: Session = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    bornAt: now,
    restoreHash: hashRestoreToken(restoreToken),
  };
  sessions.set(session.id, session);
  // Cap rows per user (LRU by createdAt) so wiping deviceId can't mint
  // unbounded live-token rows.
  const owned = [...sessions.values()]
    .filter((s) => s.serverUrl === data.serverUrl && s.userId === data.userId)
    .sort((a, b) => a.createdAt - b.createdAt);
  while (owned.length > MAX_SESSIONS_PER_USER) {
    const evicted = owned.shift();
    if (!evicted || evicted.id === session.id) break;
    replaced.push(evicted);
    sessions.delete(evicted.id);
    dirty = true;
  }
  scheduleSave();
  return { session, replaced, restoreToken };
}

/**
 * Mints a restore token for a session that predates the feature (or lost its
 * hash). Returns the raw token exactly once; only the hash is stored. Returns
 * null when the session already has a hash — the server cannot recover a raw
 * token it never kept.
 */
export function ensureRestoreToken(session: Session): string | null {
  if (session.restoreHash) return null;
  const restoreToken = crypto.randomBytes(32).toString('base64url');
  session.restoreHash = hashRestoreToken(restoreToken);
  scheduleSave();
  return restoreToken;
}

/**
 * Looks a session up by its raw restore token. Uses a constant-time digest
 * comparison and runs the same TTL/pruning path as a cookie lookup, so an
 * expired session can never be revived through its token. Returns null for
 * unknown, malformed, or pre-restore-token rows.
 */
export function findSessionByRestoreToken(token: string): Session | null {
  if (typeof token !== 'string' || !token || token.length > MAX_RESTORE_TOKEN_LENGTH) {
    return null;
  }
  const expected = Buffer.from(hashRestoreToken(token), 'hex');
  for (const [id, session] of sessions) {
    if (!session.restoreHash) continue;
    const stored = Buffer.from(session.restoreHash, 'hex');
    if (stored.length !== expected.length) continue;
    if (!crypto.timingSafeEqual(stored, expected)) continue;
    // Also prunes an expired row and slides createdAt for active devices.
    return getSession(id);
  }
  return null;
}

export function deleteSession(id: string): void {
  if (sessions.delete(id)) {
    scheduleSave();
  }
}

// Periodically purge expired sessions so the map never grows unbounded even
// when idle (also persists the pruned state).
const cleanupInterval = setInterval(() => {
  pruneExpired();
  if (dirty) scheduleSave();
}, 60 * 60 * 1000);

// Don't keep the process alive just for the cleanup timer.
cleanupInterval.unref();

/**
 * Parses a raw Cookie header into a record of name → value.
 * (Avoids pulling in cookie-parser for two call sites.)
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }
  return cookies;
}

/** Clearing needs the same identity attributes but no maxAge/expires. */
export function cookieClearOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
  };
}

export function cookieOptions(secure: boolean) {
  return {
    ...cookieClearOptions(secure),
    maxAge: SESSION_TTL_MS,
  };
}
