import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/unit/vscode-stub.ts', import.meta.url)),
    },
  },
  test: {
    name: 'extension',
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
});
