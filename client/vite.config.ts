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
    // Dev UI runs on 5174; the Express server (the production default) owns
    // 5173, so the two never collide when `npm run dev` starts them together.
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:5173',
        changeOrigin: true,
      },
    },
  },
});