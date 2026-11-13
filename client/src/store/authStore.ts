import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  name: string;
}

interface AuthState {
  serverUrl: string;
  userId: string;
  user: User | null;
  deviceId: string;
  /**
   * Long-lived per-device credential returned by /auth/login. A browser that
   * clears cookies on exit still keeps localStorage, so this lets the app
   * silently obtain a fresh session cookie on boot instead of asking for the
   * password again.
   */
  restoreToken: string;
  login: (serverUrl: string, userId: string, user: User, restoreToken?: string) => void;
  logout: () => void;
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function getOrCreateDeviceId(): string {
  const STORAGE_KEY = 'siren-device-id';
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing && DEVICE_ID_RE.test(existing)) return existing;

  // crypto.randomUUID() requires a secure context (https:, or http://localhost).
  // On plain-http LAN IP access it's unavailable, which would throw and crash
  // the whole app on load. Fall back to a v4-style random id in that case.
  const newId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
  localStorage.setItem(STORAGE_KEY, newId);
  return newId;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      serverUrl: '',
      userId: '',
      user: null,
      deviceId: getOrCreateDeviceId(),
      restoreToken: '',

      login: (serverUrl, userId, user, restoreToken = '') =>
        set({ serverUrl, userId, user, restoreToken }),

      logout: () =>
        set({ serverUrl: '', userId: '', user: null, restoreToken: '' }),
    }),
    {
      name: 'siren-auth',
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        userId: state.userId,
        user: state.user,
        restoreToken: state.restoreToken,
      }),
      // partialize is write-only; always keep the in-memory deviceId so a
      // corrupt or stale persisted blob can't replace it during rehydration.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as object),
        deviceId: current.deviceId,
      }),
    }
  )
);
