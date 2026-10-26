import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellName } from '@isar-flow/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { ConsoleRunOptions } from '../../../src/contracts';
import { createConsoleRunner, runConsoleCommand } from '../../../src/runner/consoleRunner';
import { createProcessFixtures, isAlive, waitFor } from './fixtures';

const isWindows = process.platform === 'win32';
const fixtures = createProcessFixtures();
afterAll(() => fixtures.cleanup());

const SLOW = { timeout: 30_000 };

function run(command: string, extra: Partial<ConsoleRunOptions> = {}) {
  const chunks: { stream: string; text: string }[] = [];
  const promise = runConsoleCommand({
    command,
    shell: 'auto',
    cwd: fixtures.dir,
    env: {},
    signal: new AbortController().signal,
    onData: (stream, text) => chunks.push({ stream, text }),
    ...extra,
  });
  return { promise, chunks };
}

describe('runConsoleCommand', () => {
  it('captures stdout and stderr separately and interleaved', SLOW, async () => {
    const { promise, chunks } = run(`node "${fixtures.emit}"`);
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('out1\nout2\n');
    expect(result.stderr).toBe('err1\n');
    expect(result.output).toBe('out1\nerr1\nout2\n');
    expect(chunks.map((c) => c.text).join('')).toBe(result.output);
    expect(
      chunks
        .filter((c) => c.stream === 'stderr')
        .map((c) => c.text)
        .join(''),
    ).toBe('err1\n');
  });

  it('reports the exit code of `exit 3`', SLOW, async () => {
    expect((await run('exit 3').promise).exitCode).toBe(3);
  });

  it('reports a failed command as a non-zero exit code', SLOW, async () => {
    const command = isWindows ? 'Get-Item C:/isar-flow-does-not-exist' : 'false';
    const result = await run(command).promise;
    expect(result.exitCode).toBe(1);
  });

  it('keeps the native exit code of the last program', SLOW, async () => {
    const result = await run('node -e "process.exit(7)"').promise;
    expect(result.exitCode).toBe(7);
  });

  it('decodes UTF-8 output of the shell and of programs', SLOW, async () => {
    const result = await run(`echo 'Grüße ✓'\nnode -e "console.log('Grüße ✓')"`).promise;
    expect(result.stdout).toBe('Grüße ✓\nGrüße ✓\n');
  });

  it('passes quotes through to the shell unchanged', SLOW, async () => {
    const result = await run(`node -e "console.log(JSON.stringify(process.argv.slice(1)))" 'a b' "c"`)
      .promise;
    expect(JSON.parse(result.stdout)).toEqual(['a b', 'c']);
  });

  it('runs in the working folder with the extra environment', SLOW, async () => {
    const result = await run('node -e "console.log(process.cwd() + \'|\' + process.env.ISAR_FLOW_TEST)"', {
      env: { ISAR_FLOW_TEST: 'hello' },
    }).promise;
    const [cwd, value] = result.stdout.trim().split('|');
    const norm = (p: string) => (isWindows ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync(p));
    expect(norm(cwd)).toBe(norm(fixtures.dir));
    expect(value).toBe('hello');
  });

  it('does not pass on ELECTRON_RUN_AS_NODE, which the extension host sets for itself', SLOW, async () => {
    const before = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const result = await run('node -e "console.log(process.env.ELECTRON_RUN_AS_NODE || \'unset\')"')
        .promise;
      expect(result.stdout.trim()).toBe('unset');
    } finally {
      if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = before;
    }
  });

  it('runs npm through its shim', SLOW, async () => {
    const result = await run('npm --version').promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('caps captured output and keeps head and tail', SLOW, async () => {
    const result = await run(`node "${fixtures.flood}" ${5 * 1024 * 1024}`).promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThan(4.2 * 1024 * 1024);
    expect(result.stdout).toMatch(/\n… [\d,]+ bytes omitted …\n/);
    expect(result.stdout.startsWith('x'.repeat(99))).toBe(true);
    expect(result.stdout.endsWith('END\n')).toBe(true);
    expect(result.output.length).toBeLessThan(4.2 * 1024 * 1024);
  });

  it('rejects a working folder that does not exist', async () => {
    const missing = path.join(fixtures.dir, 'missing-folder');
    await expect(run('echo hi', { cwd: missing }).promise).rejects.toThrow(
      `Working folder not found: ${missing}`,
    );
  });

  it('resolves at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run('echo hi', { signal: controller.signal }).promise;
    expect(result.exitCode).toBe(130);
    expect(result.output).toBe('');
  });
});

describe('runConsoleCommand with explicit shells', () => {
  it.runIf(isWindows)('runs cmd with exit codes and UTF-8', SLOW, async () => {
    const result = await run('echo Grüße ✓\necho "quoted" & exit 3', { shell: 'cmd' }).promise;
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('Grüße ✓\n"quoted" \n');
  });

  it.runIf(isWindows)('runs npm through cmd', SLOW, async () => {
    const result = await run('npm --version', { shell: 'cmd' }).promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.runIf(!isWindows)('runs sh with exit codes', SLOW, async () => {
    const result = await run("printf 'Grüße ✓\\n'; exit 4", { shell: 'sh' }).promise;
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe('Grüße ✓\n');
  });
});

describe('runConsoleCommand stopping processes', () => {
  // cmd/sh start fast, so the grandchild is running well before the timeout even on a busy machine.
  it('kills the whole process tree on timeout', SLOW, async () => {
    const marker = path.join(fixtures.dir, 'timeout-marker');
    const started = path.join(fixtures.dir, 'timeout-started');
    const timeoutMs = 3000;
    // taskkill alone can take over a second on a busy machine, so the marker is due well after the kill.
    const deadline = Date.now() + timeoutMs + 4000;
    const result = await run(fixtures.treeCommand(marker, started, deadline), {
      timeoutMs,
      shell: isWindows ? 'cmd' : 'sh',
    }).promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(fs.existsSync(started)).toBe(true);
    // Once the grandchild is gone it can no longer write the marker.
    expect(await waitFor(() => !isAlive(Number(fs.readFileSync(started, 'utf8'))), 5000)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('kills the process tree and resolves promptly on abort', SLOW, async () => {
    const marker = path.join(fixtures.dir, 'abort-marker');
    const started = path.join(fixtures.dir, 'abort-started');
    const controller = new AbortController();
    let abortedAt = 0;
    const result = await runConsoleCommand({
      command: fixtures.treeCommand(marker, started, '+6000'),
      shell: 'auto',
      cwd: fixtures.dir,
      env: {},
      signal: controller.signal,
      onData: (_stream, text) => {
        if (text.includes('ready') && !abortedAt) {
          abortedAt = Date.now();
          controller.abort();
        }
      },
    });
    expect(abortedAt).toBeGreaterThan(0);
    expect(Date.now() - abortedAt).toBeLessThan(2000);
    expect(result.exitCode).toBe(130);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('ready');
    expect(await waitFor(() => !isAlive(Number(fs.readFileSync(started, 'utf8'))), 5000)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('createConsoleRunner', () => {
  const options = (shell: ShellName): ConsoleRunOptions => ({
    command: 'echo hi',
    shell,
    cwd: os.tmpdir(),
    env: {},
    signal: new AbortController().signal,
    onData: () => undefined,
  });

  it('rejects with the message of a shell that cannot be resolved', async () => {
    const runner = createConsoleRunner({
      resolveShell: () => {
        throw new Error('bash was not found. Install it, or choose another shell.');
      },
    });
    await expect(runner(options('bash'))).rejects.toThrow('bash was not found');
  });

  it('rejects with a helpful message when the shell cannot be started', async () => {
    const file = path.join(os.tmpdir(), 'isar-flow-missing-shell', isWindows ? 'nosh.exe' : 'nosh');
    const runner = createConsoleRunner({
      resolveShell: () => ({ file, label: 'nosh', windowsVerbatimArguments: false, args: (c) => ['-c', c] }),
    });
    await expect(runner(options('sh'))).rejects.toThrow(/Could not start nosh.*isarFlow\.defaultShell/s);
  });
});
