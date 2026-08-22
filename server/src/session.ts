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
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_COOKIE_NAME = 'siren-session';

const sessions = new Map<string, Session>();

// ---------------------------------------------------------------------------
// Disk persistence
//
// Sessions survive app restarts by persisting to a JSON file inside the
// Electron userData directory (SIREN_DATA_DIR, set by the main process).
// Writes are debounced and atomic (tmp + rename); the file holds auth tokens
// so it is created with mode 0600.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.SIREN_DATA_DIR || path.join(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

let saveTimer: NodeJS.Timeout | null = null;
let dirty = false;

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, SESSIONS_FILE);
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
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; sessions?: Session[] };
    for (const session of parsed.sessions ?? []) {
      if (
        session &&
        typeof session.id === 'string' &&
        typeof session.createdAt === 'number' &&
        typeof session.token === 'string'
      ) {
        sessions.set(session.id, session);
      }
    }
    pruneExpired();
  } catch {
    // Missing or corrupt file — start with a clean slate.
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
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(id);
    scheduleSave();
    return null;
  }
  return session;
}

export function createSession(data: Omit<Session, 'id' | 'createdAt'>): Session {
  // Replace any previous session for the same identity so repeated logins
  // don't accumulate rows with live tokens until TTL.
  for (const [id, existing] of sessions) {
    if (existing.serverUrl === data.serverUrl && existing.userId === data.userId) {
      sessions.delete(id);
      dirty = true;
    }
  }

  const session: Session = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  scheduleSave();
  return session;
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
