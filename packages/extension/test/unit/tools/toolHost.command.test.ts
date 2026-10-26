import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleResult, createHarness, type Harness } from './harness';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.cleanup());

describe('runCommand', () => {
  it('runs in the workspace root with the default shell and a 120 s timeout', async () => {
    h.runCommand = async () => consoleResult({ stdout: 'all good\n' });
    const result = await h.call('runCommand', { command: 'npm test' });
    expect(result).toEqual({ content: 'exit code 0\nall good\n' });
    expect(h.commands[0]).toMatchObject({
      command: 'npm test',
      shell: 'auto',
      cwd: h.root,
      env: {},
      timeoutMs: 120_000,
      signal: h.controller.signal,
    });
  });

  it('reports a non-zero exit code as a normal result', async () => {
    h.runCommand = async () => consoleResult({ exitCode: 2, stdout: 'failing\n' });
    const result = await h.call('runCommand', { command: 'npm test' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('exit code 2\nfailing\n');
  });

  it('says when there is no output', async () => {
    h.runCommand = async () => consoleResult();
    expect((await h.call('runCommand', { command: 'true' })).content).toBe('exit code 0\n(no output)');
  });

  it('keeps only the last 20 KB of output', async () => {
    const output = `${'a'.repeat(30 * 1024)}THE END\n`;
    h.runCommand = async () => consoleResult({ stdout: output });
    const result = await h.call('runCommand', { command: 'build' });
    expect(result.content.length).toBeLessThan(20 * 1024 + 200);
    expect(result.content).toMatch(/^exit code 0\n… \d+ earlier characters omitted …\n/);
    expect(result.content.endsWith('THE END\n')).toBe(true);
  });

  it('reports a timeout as an error', async () => {
    h.runCommand = async () => consoleResult({ exitCode: 124, timedOut: true, stdout: 'waiting\n' });
    const result = await h.call('runCommand', { command: 'npm start' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Timed out after 120 s/);
    expect(result.content).toContain('waiting');
  });

  it('runs in a workspace-relative folder', async () => {
    h.write('packages/app/package.json', '{}');
    await h.call('runCommand', { command: 'npm test', cwd: 'packages/app' });
    expect(h.commands[0].cwd).toBe(path.join(h.root, 'packages', 'app'));
  });

  it('refuses a folder outside the workspace', async () => {
    const result = await h.call('runCommand', { command: 'ls', cwd: '..' });
    expect(result.isError).toBe(true);
    expect(h.commands).toHaveLength(0);
  });

  it('mirrors output into the step log', async () => {
    h.runCommand = async (options) => {
      options.onData('stdout', 'line\n');
      options.onData('stderr', 'warn\n');
      return consoleResult({ stdout: 'line\n', stderr: 'warn\n' });
    };
    await h.call('runCommand', { command: 'x' });
    expect(h.logs).toEqual([
      { stream: 'stdout', text: 'line\n' },
      { stream: 'stderr', text: 'warn\n' },
    ]);
  });

  it('returns runner failures as errors', async () => {
    h.runCommand = async () => {
      throw new Error('PowerShell 7 (pwsh) was not found.');
    };
    const result = await h.call('runCommand', { command: 'x' });
    expect(result).toEqual({ isError: true, content: expect.stringContaining('pwsh) was not found') });
  });
});

describe('command permissions', () => {
  it('"none" refuses and names the setting', async () => {
    const result = await h.call('runCommand', { command: 'rm -rf /' }, { commands: 'none', edits: 'auto' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/permissions\.commands/);
    expect(h.commands).toHaveLength(0);
  });

  it('"ask" shows the command and runs it when allowed', async () => {
    h.answers.push('allow');
    h.write('sub/.keep', '');
    await h.call('runCommand', { command: 'npm test -- --watch=false', cwd: 'sub' }, { commands: 'ask' });
    expect(h.prompts[0]).toMatchObject({ tool: 'runCommand', summary: 'Run: npm test -- --watch=false' });
    expect(h.prompts[0].detail).toContain('sub');
    expect(h.commands).toHaveLength(1);
  });

  it('"ask" denial does not run the command', async () => {
    const result = await h.call('runCommand', { command: 'npm publish' }, { commands: 'ask' });
    expect(result.isError).toBe(true);
    expect(h.commands).toHaveLength(0);
  });

  it('"allow for this run" is remembered by the host', async () => {
    h.answers.push('allowRun');
    await h.call('runCommand', { command: 'a' }, { commands: 'ask' });
    await h.call('runCommand', { command: 'b' }, { commands: 'ask' });
    expect(h.prompts).toHaveLength(1);
    expect(h.commands.map((c) => c.command)).toEqual(['a', 'b']);
  });
});

describe('aborts', () => {
  it('rejects when the signal is already aborted', async () => {
    h.controller.abort(new Error('Run cancelled'));
    await expect(h.call('readFile', { path: 'x' })).rejects.toThrow('Run cancelled');
  });

  it('rejects when the run is cancelled while the prompt is open', async () => {
    h.prompt = () => new Promise(() => undefined);
    const call = h.call('writeFile', { path: 'x.txt', content: 'x' }, { edits: 'ask' });
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    h.controller.abort();
    await expect(call).rejects.toThrow();
  });

  it('rejects when the command was cut short by the abort', async () => {
    h.runCommand = async () => {
      h.controller.abort();
      return consoleResult({ exitCode: 130 });
    };
    await expect(h.call('runCommand', { command: 'sleep 100' })).rejects.toThrow();
  });
});
