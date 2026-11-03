import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRequest,
  ConsoleResult,
  ModelResolver,
  ProjectMemory,
  StepIO,
  ToolHost,
} from '@isar-flow/core';
import type { ConsoleRunOptions } from '@isar-flow/core/node';
import { createCliHost, type CliHostDeps } from '../src/host';
import type { TerminalPrompts } from '../src/prompts';

const root = path.resolve('/work/repo');

function io(logs: { stream: string; text: string }[] = []): StepIO {
  return {
    runId: 'r1',
    stepId: 'step',
    signal: new AbortController().signal,
    log: (stream, text) => logs.push({ stream, text }),
  };
}

function setup(overrides: Partial<CliHostDeps> = {}) {
  const commands: ConsoleRunOptions[] = [];
  const prompts: TerminalPrompts = {
    approve: vi.fn(async () => ({ approved: true })),
    ask: vi.fn(async () => ({ answer: '••••••' })),
    permission: vi.fn(async () => 'allow' as const),
  };
  const deps: CliHostDeps = {
    root,
    runCommand: async (options): Promise<ConsoleResult> => {
      commands.push(options);
      options.onData('stdout', 'hello\n');
      return { exitCode: 0, stdout: 'hello\n', stderr: '', output: 'hello\n', timedOut: false };
    },
    models: { resolve: vi.fn() } as ModelResolver,
    prompts,
    secrets: { token: 'tok-secret' },
    toolHost: { execute: vi.fn() } as ToolHost,
    readContextFiles: async () => [],
    ...overrides,
  };
  return { host: createCliHost(deps), commands, prompts, deps };
}

describe('createCliHost', () => {
  it('runs console blocks in the workspace folder and streams their output', async () => {
    const { host, commands } = setup();
    const logs: { stream: string; text: string }[] = [];
    const result = await host.runConsole(
      {
        stepId: 'build',
        command: 'npm test',
        shell: 'auto',
        cwd: 'packages/app',
        env: { CI: '1' },
        timeoutMs: 5000,
      },
      io(logs),
    );
    expect(result.exitCode).toBe(0);
    expect(commands[0]).toMatchObject({
      command: 'npm test',
      shell: 'auto',
      cwd: path.join(root, 'packages', 'app'),
      env: { CI: '1' },
      timeoutMs: 5000,
    });
    expect(logs).toEqual([{ stream: 'stdout', text: 'hello\n' }]);
  });

  it('asks approvals with secrets masked', async () => {
    const { host, prompts } = setup();
    await host.requestApproval({ stepId: 'ok', message: 'Use tok-secret?' }, io());
    expect(prompts.approve).toHaveBeenCalledWith(
      { stepId: 'ok', message: 'Use ••••••?' },
      expect.any(AbortSignal),
    );
  });

  it('asks questions with secrets masked and maps a masked choice back', async () => {
    const { host, prompts } = setup();
    const result = await host.askUser?.(
      {
        stepId: 'pick',
        question: 'Which of tok-secret?',
        choices: ['tok-secret', 'other'],
        default: 'other',
      },
      io(),
    );
    expect(prompts.ask).toHaveBeenCalledWith(
      { stepId: 'pick', question: 'Which of ••••••?', choices: ['••••••', 'other'], default: 'other' },
      expect.any(AbortSignal),
    );
    expect(result).toEqual({ answer: 'tok-secret' });
  });

  it('runs agent blocks with the resolver, tools, context files and memory', async () => {
    const memory: ProjectMemory = { read: vi.fn(async () => 'Use pnpm.'), append: vi.fn() };
    const resolve = vi.fn(async () => {
      throw new Error('offline');
    });
    const readContextFiles = vi.fn(async () => [{ path: 'a.md', content: 'A' }]);
    const { host } = setup({ models: { resolve }, memory, readContextFiles });
    const request: AgentRequest = {
      stepId: 'fix',
      agent: { name: 'Coder', model: 'local/qwen' },
      prompt: 'Fix it',
      history: [],
      contextFiles: ['*.md'],
    };
    await expect(host.runAgent(request, io())).rejects.toThrow('offline');
    expect(resolve).toHaveBeenCalledWith('local/qwen');
    expect(readContextFiles).toHaveBeenCalledWith(['*.md'], expect.any(AbortSignal));
    expect(memory.read).toHaveBeenCalled();
  });
});
