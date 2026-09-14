import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Subpath support: set VITE_BASE_PATH=/siren to build for serving under a
// reverse-proxy subpath. Defaults to '/' (root) for Electron + local dev.
// Dev server itself always stays root-only; only prod builds use the base.
let basePath = (process.env.VITE_BASE_PATH || '/').trim();
if (!basePath.startsWith('/')) basePath = `/${basePath}`;
basePath = basePath.replace(/^\/{2,}/, '/');
if (!basePath.endsWith('/')) basePath += '/';

export default defineConfig({
  base: basePath,
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
    // NOTE: dev is root-only — the proxy below forwards plain /api, so
    // running dev with VITE_BASE_PATH=/siren would make withBase('/api')
    // request /siren/api (404). Only prod builds use the base.
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