import axios from 'axios';
import { useAuthStore } from '@/store/authStore';
import { withBase } from '@/lib/base';

export const apiClient = axios.create({
  baseURL: withBase('/api'),
  timeout: 30000,
  // Send the httpOnly session cookie on every request.
  withCredentials: true,
});

// Playback reporting must never log the user out mid-song: it uses a bare
// client with no 401 interceptor so an expired session just fails silently.
export const reportClient = axios.create({
  baseURL: withBase('/api'),
  timeout: 10000,
  withCredentials: true,
});

// Response interceptor: handle 401 by deleting the server session, clearing
// local state, and redirecting to login.
//
// - /auth/* endpoints are exempt: a 401 from /auth/login is just a wrong
//   password and must NOT wipe the form via a forced reload.
// - The server-side session delete is awaited before navigating; a
//   fire-and-forget POST would be aborted by the redirect, leaving an
//   orphaned session (with a live Jellyfin token) until its TTL expires.
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    // Machine-readable failure code (see server/src/types.ts). Older servers
    // and the Electron bridge's synthetic errors do not send one, so fall back
    // to the status check below for untagged responses.
    const code: string | undefined = error.response?.data?.code;
    const requestUrl: string = error.config?.url || '';
    // Pathname-based so this stays correct under a subpath base (withBase)
    // and if baseURL ever becomes absolute. error.config.url is the relative
    // path as passed ('/auth/...'), but be defensive either way.
    // Anchor to the API auth prefix so a future /proxy path containing
    // "/auth/" can't falsely suppress logout.
    let requestPath = requestUrl;
    try {
      requestPath = new URL(requestUrl, 'http://localhost').pathname;
    } catch {
      // keep raw value
    }
    const isAuthRoute =
      requestPath === '/auth/login' ||
      requestPath === '/auth/logout' ||
      requestPath === '/auth/session';
    // When a code is present, require both the Siren session-failure code and a
    // 401, so a relayed body carrying a coincidental code at another status
    // cannot force logout; untagged responses keep the status-only behavior.
    const isUnauthenticated = code
      ? code === 'NOT_AUTHENTICATED' && status === 401
      : status === 401;
    if (isUnauthenticated && !isAuthRoute) {
      try {
        await apiClient.post('/auth/logout');
      } catch {
        // Best effort — the session also expires via TTL.
      }
      useAuthStore.getState().logout();
      window.location.href = withBase('/login');
    }
    return Promise.reject(error);
  }
);