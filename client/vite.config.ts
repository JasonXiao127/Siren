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
    // Dev UI runs on 5177; the Express server (embedded in Electron's
    // utility process) owns 5176, so the two never collide. strictPort
    // prevents Vite from silently incrementing the port if 5177 is busy —
    // the Electron dev shell would otherwise load a URL that serves nothing.
    // Web (Siren) keeps 5174/5173 — this offset lets both run side-by-side.
    port: 5177,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5176',
        changeOrigin: true,
      },
    },
  },
});