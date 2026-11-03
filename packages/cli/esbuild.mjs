import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/**
 * Bundles the command line runner into dist/cli.js (ESM, Node 20+), run as `node packages/cli/dist/cli.js` or as
 * the `isar-flow` binary. Core and its dependencies (yaml, zod) are bundled, so the file runs on its own.
 */
const options = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  banner: {
    // Bundled CommonJS code may call require() for Node built-ins; ESM output has no require of its own.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __isarFlowCreateRequire } from 'node:module';",
      'const require = __isarFlowCreateRequire(import.meta.url);',
    ].join('\n'),
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
