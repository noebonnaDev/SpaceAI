import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        // MSAL v5 redirect bridge: the redirect URI registered in Entra ID points here.
        redirect: resolve(import.meta.dirname, 'redirect.html'),
        taskpane: resolve(import.meta.dirname, 'addin/taskpane.html'),
        commands: resolve(import.meta.dirname, 'addin/commands.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080' },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
} as any);
