import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'extension',
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
});
