// Bundles the integration test runner and every suite to CommonJS in out/test/integration, keeping the
// suite folders: suite/ (fixture workspace) and no-folder/ (window without a folder).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..', '..');
export const integrationOutDir = path.join(packageDir, 'out', 'test', 'integration');
export const SUITE_DIRS = ['suite', 'no-folder'];

export async function buildIntegrationTests() {
  const suites = SUITE_DIRS.flatMap((dir) =>
    fs
      .readdirSync(path.join(testDir, dir))
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => path.join(testDir, dir, file)),
  );
  fs.rmSync(integrationOutDir, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [path.join(testDir, 'index.ts'), ...suites],
    outbase: testDir,
    outdir: integrationOutDir,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    // The test instance provides vscode; mocha is loaded from node_modules so all suites share one instance.
    external: ['vscode', 'mocha'],
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  return integrationOutDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildIntegrationTests();
}
