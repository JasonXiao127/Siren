import axios from 'axios';
import { useAuthStore } from '@/store/authStore';

export const apiClient = axios.create({
  baseURL: '/api',
  timeout: 30000,
  // Send the httpOnly session cookie on every request.
  withCredentials: true,
});

// Response interceptor: handle 401 by logging out and redirecting
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);