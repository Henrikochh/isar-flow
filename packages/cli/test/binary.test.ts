import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, writeFile } from './helpers';

let outDir: string;
let cli: string;

/** The same bundle as esbuild.mjs (ESM, Node 20, shebang and createRequire banner), in a temp folder. */
beforeAll(async () => {
  outDir = makeTempDir('isar-cli-bin-');
  cli = path.join(outDir, 'cli.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'index.ts')],
    bundle: true,
    outfile: cli,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __isarFlowCreateRequire } from 'node:module';",
        'const require = __isarFlowCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  });
}, 60_000);
afterAll(() => removeDir(outDir));

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBinary(
  args: string[],
  cwd: string,
  onStdout?: (text: string, child: ReturnType<typeof spawn>) => void,
) {
  return new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      onStdout?.(stdout, child);
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('the built isar-flow binary', () => {
  it('starts with a shebang and prints its help', async () => {
    expect(fs.readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    const result = await runBinary(['--help'], outDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: isar-flow run <file> [options]');
  }, 30_000);

  it('refuses an MCP mode', async () => {
    const result = await runBinary(['mcp', '--stdio'], outDir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option '--stdio'.");
  }, 30_000);

  it('runs a console workflow', async () => {
    const root = makeTempDir('isar cli bin ws-');
    try {
      writeFile(
        root,
        '.isarflow/workflows/hello.workflow.yaml',
        'version: 1\nname: Hello\ninputs:\n  who: { type: string, required: true }\nsteps:\n' +
          '  - id: greet\n    type: console\n    run: node -e "console.log(\'Hello, \' + process.argv[1])" ${{ inputs.who }}\n',
      );
      const result = await runBinary(['run', 'hello', '--input', 'who=CLI'], root);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('    Hello, CLI\n');
      expect(result.stdout).toContain('Succeeded in');
    } finally {
      removeDir(root);
    }
  }, 60_000);

  it('prints one JSON document with --json and exits with 0', async () => {
    const root = makeTempDir('isar-cli-json-');
    try {
      writeFile(
        root,
        '.isarflow/workflows/hello.workflow.yaml',
        'version: 1\nname: Hello\nsteps:\n  - id: greet\n    type: console\n    run: node -e "console.log(\'json-ok\')"\n',
      );
      const result = await runBinary(['run', 'hello', '--json'], root);
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toMatchObject({
        workflow: { name: 'Hello', file: '.isarflow/workflows/hello.workflow.yaml' },
        status: 'success',
        origin: { kind: 'cli' },
        steps: { greet: { status: 'success', output: { exitCode: 0, stdout: 'json-ok\n' } } },
      });
      expect(result.stderr).toContain('Running Hello');
    } finally {
      removeDir(root);
    }
  }, 60_000);

  it('exits with 1 when a block fails', async () => {
    const root = makeTempDir('isar-cli-fail-');
    try {
      writeFile(
        root,
        '.isarflow/workflows/broken.workflow.yaml',
        'version: 1\nname: Broken\nsteps:\n  - id: boom\n    type: console\n    run: node -e "process.exit(3)"\n',
      );
      const result = await runBinary(['run', 'broken', '--json'], root);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'failure',
        steps: { boom: { status: 'failure', output: { exitCode: 3 } } },
      });
    } finally {
      removeDir(root);
    }
  }, 60_000);

  it('runs no command with --simulate', async () => {
    const root = makeTempDir('isar-cli-sim-');
    try {
      writeFile(
        root,
        '.isarflow/workflows/touch.workflow.yaml',
        'version: 1\nname: Touch\nsteps:\n  - id: touch\n    type: console\n' +
          "    run: node -e \"require('fs').writeFileSync('ran.txt', 'x')\"\n",
      );
      const result = await runBinary(['run', 'touch', '--simulate', '--json'], root);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'success', simulated: true });
      expect(result.stderr).toContain('Simulated run: nothing is executed');
      expect(fs.existsSync(path.join(root, 'ran.txt'))).toBe(false);
    } finally {
      removeDir(root);
    }
  }, 60_000);

  it('says how to name the workflow when the file does not exist', async () => {
    const result = await runBinary(['run', 'fix-tests'], outDir);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      "Could not find 'fix-tests'. Pass the path of a .workflow.yaml file, e.g. .isarflow/workflows/fix-tests.workflow.yaml.",
    );
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'cancels on Ctrl+C (SIGINT) and exits with 130',
    async () => {
      const root = makeTempDir('isar-cli-sigint-');
      try {
        writeFile(
          root,
          '.isarflow/workflows/sleep.workflow.yaml',
          'version: 1\nname: Sleep\nsteps:\n  - id: wait\n    type: console\n    run: node -e "setTimeout(() => {}, 60000)"\n',
        );
        let sent = false;
        const result = await runBinary(['run', 'sleep'], root, (stdout, child) => {
          if (!sent && stdout.includes('$ node')) {
            sent = true;
            setTimeout(() => child.kill('SIGINT'), 300);
          }
        });
        expect(result.code).toBe(130);
        expect(result.stderr).toContain('Cancelling… Press Ctrl+C again to stop immediately.');
        expect(result.stdout).toContain('Cancelled after');
      } finally {
        removeDir(root);
      }
    },
    60_000,
  );
});
