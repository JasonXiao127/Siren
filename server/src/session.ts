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
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days sliding
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days absolute max
export const MAX_SESSIONS_PER_USER = 10;
export const SESSION_COOKIE_NAME = 'siren-session';

const sessions = new Map<string, Session>();

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

/** Loads persisted sessions at startup, pruning expired entries. */
export function loadSessions(): void {
  const sessionsFile = getSessionsFile();
  try {
    const raw = fs.readFileSync(sessionsFile, 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; sessions?: Session[] };
    for (const session of parsed.sessions ?? []) {
      if (
        session &&
        typeof session.id === 'string' &&
        typeof session.createdAt === 'number' &&
        typeof session.token === 'string'
      ) {
        // Migrate pre-bornAt rows: absolute lifetime starts at createdAt.
        if (typeof session.bornAt !== 'number') {
          session.bornAt = session.createdAt;
        }
        sessions.set(session.id, session);
      }
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
  if (!session) return null;
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
}

export function createSession(data: Omit<Session, 'id' | 'createdAt' | 'bornAt'>): CreateSessionResult {
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
  const session: Session = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    bornAt: now,
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
  return { session, replaced };
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

export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}
