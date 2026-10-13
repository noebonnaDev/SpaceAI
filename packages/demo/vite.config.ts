import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const shim = (file: string) => fileURLToPath(new URL(`./src/shims/${file}`, import.meta.url));

// Builds the web app together with the server code into a static site that needs no server at all.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // Browser stand-ins for Node modules. Tests run in Node and keep the real ones (the database engine needs them there).
    alias: process.env.VITEST
      ? []
      : [
          { find: /^node:crypto$/, replacement: shim('node-crypto.ts') },
          { find: /^node:(fs|fs\/promises|path|url)$/, replacement: shim('node-misc.ts') },
          { find: /^(pg|@azure\/msal-node)$/, replacement: shim('node-misc.ts') },
        ],
  },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Artifacts serve standard web types only. PGlite's file-system bundle (.data) is fetched as plain bytes,
        // never compiled, so it travels under a .wasm name; Vite rewrites the reference in the code accordingly.
        assetFileNames: (asset: { names?: string[]; name?: string }) =>
          (asset.names?.[0] ?? asset.name ?? '').endsWith('.data') ? 'assets/[name]-[hash].data.wasm' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
} as any);
