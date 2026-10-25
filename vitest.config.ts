import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/extension', 'packages/webview-ui'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['**/*.d.ts', 'packages/webview-ui/src/main.tsx'],
    },
  },
});
