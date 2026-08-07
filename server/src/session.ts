import crypto from 'crypto';

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

export function getSession(id: string): Session | null {
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function createSession(data: Omit<Session, 'id' | 'createdAt'>): Session {
  const session: Session = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

// Periodically purge expired sessions so the in-memory map never grows unbounded.
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
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