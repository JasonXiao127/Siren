import axios from 'axios';
import { useAuthStore } from '@/store/authStore';

export const apiClient = axios.create({
  baseURL: '/api',
  timeout: 30000,
  // Send the httpOnly session cookie on every request.
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
    const requestUrl: string = error.config?.url || '';
    if (status === 401 && !requestUrl.startsWith('/auth/')) {
      try {
        await apiClient.post('/auth/logout');
      } catch {
        // Best effort — the session also expires via TTL.
      }
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);