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
  login: (serverUrl: string, userId: string, user: User) => void;
  logout: () => void;
}

function getOrCreateDeviceId(): string {
  const STORAGE_KEY = 'siren-device-id';
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

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

      login: (serverUrl, userId, user) =>
        set({ serverUrl, userId, user }),

      logout: () =>
        set({ serverUrl: '', userId: '', user: null }),
    }),
    {
      name: 'siren-auth',
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        userId: state.userId,
        user: state.user,
      }),
    }
  )
);