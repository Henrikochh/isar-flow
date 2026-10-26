import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChatMessage,
  ChatModel,
  ConsoleResult,
  LogStream,
  ModelResolver,
  StepIO,
  ToolHost,
} from '@isar-flow/core';
import type { ConsoleRunOptions, RunConsoleCommand } from '../../../src/contracts';
import { createEngineHost } from '../../../src/run/engineHost';
import { FakeTerminal } from './fakes';

const ROOT = path.resolve('/ws');

function io(): StepIO & { logs: [LogStream, string][] } {
  const logs: [LogStream, string][] = [];
  return {
    runId: 'run-1',
    stepId: 'build',
    signal: new AbortController().signal,
    log: (s, t) => logs.push([s, t]),
    logs,
  };
}

function host(
  runCommand: RunConsoleCommand,
  extra: { models?: ModelResolver; times?: number[]; secrets?: Record<string, string> } = {},
) {
  const terminal = new FakeTerminal();
  const approve = vi.fn(async () => ({ approved: true }));
  const readContextFiles = vi.fn(async () => [{ path: 'src/a.ts', content: 'export const a = 1;' }]);
  const toolHost: ToolHost = { execute: async () => ({ content: '' }) };
  const times = extra.times ?? [1000, 2200];
  const engineHost = createEngineHost({
    runId: 'run-1',
    workspaceRoot: ROOT,
    runCommand,
    terminal,
    models: extra.models ?? { resolve: async () => Promise.reject(new Error('no models')) },
    toolHost,
    readContextFiles,
    approve,
    now: () => times.shift() ?? 0,
    ...(extra.secrets && { secrets: extra.secrets }),
  });
  return { engineHost, terminal, approve, readContextFiles };
}

const ok = (output: string): ConsoleResult => ({
  exitCode: 0,
  stdout: output,
  stderr: '',
  output,
  timedOut: false,
});

describe('createEngineHost runConsole', () => {
  it('runs the command in the resolved cwd and mirrors output to the terminal and logs', async () => {
    let options: ConsoleRunOptions | undefined;
    const runCommand: RunConsoleCommand = async (o) => {
      options = o;
      o.onData('stdout', 'line 1\nline 2\n');
      o.onData('stderr', 'warn\n');
      return ok('line 1\nline 2\nwarn\n');
    };
    const { engineHost, terminal } = host(runCommand);
    const stepIo = io();
    const result = await engineHost.runConsole(
      {
        stepId: 'build',
        command: 'npm run build',
        shell: 'bash',
        cwd: 'packages/app',
        env: { CI: '1' },
        timeoutMs: 5000,
      },
      stepIo,
    );

    expect(result.exitCode).toBe(0);
    expect(options).toMatchObject({
      command: 'npm run build',
      shell: 'bash',
      cwd: path.resolve(ROOT, 'packages/app'),
      env: { CI: '1' },
      timeoutMs: 5000,
      signal: stepIo.signal,
    });
    expect(stepIo.logs).toEqual([
      ['stdout', 'line 1\nline 2\n'],
      ['stderr', 'warn\n'],
    ]);
    expect(terminal.text).toContain('\x1b[2m▶ build\x1b[0m npm run build\r\n');
    expect(terminal.text).toContain('line 1\r\nline 2\r\nwarn\r\n');
    expect(terminal.text).toContain('\x1b[32m✓ exit 0 · 1.2 s\x1b[0m\r\n');
    expect(terminal.shown).toBe(1);
  });

  it('keeps absolute working folders and defaults to the workspace root', async () => {
    const cwds: string[] = [];
    const runCommand: RunConsoleCommand = async (o) => {
      cwds.push(o.cwd);
      return ok('');
    };
    const { engineHost } = host(runCommand, { times: [0, 0, 0, 0] });
    const absolute = path.resolve('/elsewhere');
    await engineHost.runConsole({ stepId: 'a', command: 'x', shell: 'auto', cwd: absolute, env: {} }, io());
    await engineHost.runConsole({ stepId: 'b', command: 'x', shell: 'auto', cwd: '', env: {} }, io());
    expect(cwds).toEqual([absolute, ROOT]);
  });

  it('writes a red footer for failures and starts it on a new line', async () => {
    const { engineHost, terminal } = host(
      async (o) => {
        o.onData('stderr', 'boom');
        return { exitCode: 1, stdout: '', stderr: 'boom', output: 'boom', timedOut: false };
      },
      { times: [0, 3400] },
    );
    await engineHost.runConsole(
      { stepId: 'test', command: 'npm test', shell: 'auto', cwd: ROOT, env: {} },
      io(),
    );
    expect(terminal.text).toContain('boom\r\n\x1b[31m✗ exit 1 · 3.4 s\x1b[0m\r\n');
  });

  it('notes timeouts and errors in the footer and rethrows errors', async () => {
    const timedOut = host(async () => ({ exitCode: 1, stdout: '', stderr: '', output: '', timedOut: true }), {
      times: [0, 65_000],
    });
    await timedOut.engineHost.runConsole(
      { stepId: 's', command: 'sleep', shell: 'auto', cwd: ROOT, env: {} },
      io(),
    );
    expect(timedOut.terminal.text).toContain('✗ timed out · 1 m 5 s');

    const failing = host(async () => Promise.reject(new Error('spawn ENOENT')), { times: [0, 100] });
    await expect(
      failing.engineHost.runConsole({ stepId: 's', command: 'x', shell: 'auto', cwd: ROOT, env: {} }, io()),
    ).rejects.toThrow('spawn ENOENT');
    expect(failing.terminal.text).toContain('✗ spawn ENOENT · 0.1 s');
  });

  it('shows the terminal only once per run and separates steps', async () => {
    const { engineHost, terminal } = host(async () => ok(''), { times: [0, 0, 0, 0] });
    await engineHost.runConsole({ stepId: 'a', command: 'x', shell: 'auto', cwd: ROOT, env: {} }, io());
    await engineHost.runConsole({ stepId: 'b', command: 'y\nz', shell: 'auto', cwd: ROOT, env: {} }, io());
    expect(terminal.shown).toBe(1);
    expect(terminal.text).toContain('\r\n\r\n\x1b[2m▶ b\x1b[0m y\r\n  z\r\n');
  });
});

describe('createEngineHost runAgent and requestApproval', () => {
  it('runs agents through the core agent runtime with context files', async () => {
    const seen: ChatMessage[][] = [];
    const model: ChatModel = {
      ref: 'fake/m',
      provider: 'fake',
      providerLabel: 'Fake',
      id: 'm',
      name: 'M',
      capabilities: { tools: true, jsonSchema: false },
      async *chat(messages) {
        seen.push(messages);
        yield { type: 'text', text: 'hello' };
        yield { type: 'usage', inputTokens: 3, outputTokens: 2 };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const { engineHost, readContextFiles } = host(async () => ok(''), {
      models: { resolve: async () => model },
    });
    const result = await engineHost.runAgent(
      {
        stepId: 'ask',
        agent: { name: 'Helper', model: 'fake/m' },
        prompt: 'Say hello',
        history: [],
        contextFiles: ['src/*.ts'],
      },
      io(),
    );
    expect(result).toMatchObject({
      text: 'hello',
      model: 'fake/m',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(readContextFiles).toHaveBeenCalledWith(['src/*.ts'], expect.anything());
    const userMessage = seen[0].find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('src/a.ts');
  });

  it('forwards approvals', async () => {
    const { engineHost, approve } = host(async () => ok(''));
    const stepIo = io();
    expect(await engineHost.requestApproval({ stepId: 'gate', message: 'Ship?' }, stepIo)).toEqual({
      approved: true,
    });
    expect(approve).toHaveBeenCalledWith({ stepId: 'gate', message: 'Ship?' }, stepIo.signal);
  });
});

describe('createEngineHost secrets', () => {
  const secrets = { TOKEN: 'tok-SECRET-123', SHORT: 'ab' };

  it('masks secret values in the terminal, also when they arrive split over chunks', async () => {
    const { engineHost, terminal } = host(
      async (o) => {
        o.onData('stdout', 'auth tok-SEC');
        o.onData('stdout', 'RET-123 ok\n');
        o.onData('stderr', 'used tok-SECRET-123\n');
        return ok('');
      },
      { secrets, times: [0, 0] },
    );
    const stepIo = io();
    await engineHost.runConsole(
      { stepId: 'deploy', command: 'deploy --token tok-SECRET-123', shell: 'auto', cwd: ROOT, env: {} },
      stepIo,
    );
    expect(terminal.text).not.toContain('SECRET');
    expect(terminal.text).toContain('deploy --token ••••••');
    expect(terminal.text).toContain('auth •••••• ok\r\n');
    expect(terminal.text).toContain('used ••••••\r\n');
    // The engine masks the step log itself (it also sees secrets split over chunks).
    expect(stepIo.logs.map(([, text]) => text).join('')).toContain('tok-SECRET-123');
  });

  it('writes a held-back partial match before the footer', async () => {
    const { engineHost, terminal } = host(
      async (o) => {
        o.onData('stdout', 'ends with tok-');
        return ok('');
      },
      { secrets, times: [0, 0] },
    );
    await engineHost.runConsole({ stepId: 's', command: 'x', shell: 'auto', cwd: ROOT, env: {} }, io());
    expect(terminal.text).toContain('ends with tok-\r\n\x1b[32m✓ exit 0');
  });

  it('masks secret values in approval messages', async () => {
    const { engineHost, approve } = host(async () => ok(''), { secrets });
    const stepIo = io();
    await engineHost.requestApproval({ stepId: 'gate', message: 'Deploy with tok-SECRET-123?' }, stepIo);
    expect(approve).toHaveBeenCalledWith({ stepId: 'gate', message: 'Deploy with ••••••?' }, stepIo.signal);
  });
});
