import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Dev UI runs on 5174; the Express server (embedded in Electron's
    // utility process) owns 5173, so the two never collide. strictPort
    // prevents Vite from silently incrementing the port if 5174 is busy —
    // the Electron dev shell would otherwise load a URL that serves nothing.
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5173',
        changeOrigin: true,
      },
    },
  },
});