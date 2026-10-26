import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/extension', 'packages/webview-ui'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['**/*.d.ts', 'packages/webview-ui/src/main.tsx'],
      // Coverage gate of the test concept (spec §11), checked by `npm run test:coverage` without --project.
      thresholds: {
        'packages/core/src/**': { lines: 90 },
        'packages/extension/src/**': { lines: 70 },
      },
    },
  },
});
