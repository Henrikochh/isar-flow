/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const here = import.meta.dirname;

// The webview bundle is loaded by the extension from media/webview with fixed file names.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(here, '../extension/media/webview'),
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: resolve(here, 'index.html'),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: (asset) =>
          asset.names?.[0]?.endsWith('.css') ? 'main.css' : 'assets/[name][extname]',
      },
    },
  },
  test: {
    name: 'webview-ui',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
