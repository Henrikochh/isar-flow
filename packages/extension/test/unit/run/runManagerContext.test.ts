import { describe, expect, it, vi } from 'vitest';
import type { EditorContext, GitContext, ProjectMemory, RunOrigin } from '@isar-flow/core';
import type { CodeContextCapture, MemoryService } from '../../../src/contracts';
import { createEngineHost } from '../../../src/run/engineHost';
import { flush } from './fakes';
import { setup, untilAborted } from './managerSetup';

vi.mock('../../../src/run/engineHost', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/run/engineHost')>();
  return { ...real, createEngineHost: vi.fn(real.createEngineHost) };
});

const EDITOR: EditorContext = {
  selection: 'const a = 1;',
  file: 'src/a.ts',
  language: 'typescript',
  line: 3,
};
const GIT: GitContext = { branch: 'main', changedFiles: ['src/a.ts'], diff: '+const a = 1;' };

const USES_BOTH = `version: 1
name: Explain
steps:
  - id: show
    type: console
    run: echo \${{ editor.file }} \${{ git.branch }}
`;

const USES_EDITOR = `version: 1
name: Explain
steps:
  - id: show
    type: console
    run: echo \${{ editor.file }}:\${{ editor.line }}
`;

const USES_NONE = `version: 1
name: Build
steps:
  - id: build
    type: console
    run: npm run build
`;

function fakeCapture(git: CodeContextCapture['git'] = async () => GIT) {
  return {
    editor: vi.fn((_root: string): EditorContext | undefined => EDITOR),
    git: vi.fn(git),
    dispose: vi.fn(),
  } satisfies CodeContextCapture;
}

describe('createRunManager editor and git capture', () => {
  it('captures the editor at start and git from the workspace folder for workflows that read them', async () => {
    const codeContext = fakeCapture();
    const t = setup({ text: USES_BOTH, codeContext });
    const runId = (await t.manager.start(t.uri)) as string;
    const view = await t.manager.whenFinished(runId);
    expect(codeContext.editor).toHaveBeenCalledWith('/ws');
    expect(codeContext.git).toHaveBeenCalledWith('/ws', expect.any(AbortSignal));
    expect(t.commands.map((c) => c.command)).toEqual(['echo src/a.ts main']);
    expect(view?.context?.editor).toEqual(EDITOR);
    expect(view?.context?.git).toEqual(GIT);
  });

  it('captures the editor before any prompt', async () => {
    const order: string[] = [];
    const codeContext = fakeCapture();
    codeContext.editor.mockImplementation(() => {
      order.push('editor');
      return EDITOR;
    });
    const t = setup({ text: USES_EDITOR, codeContext });
    vi.mocked(t.ui.readText).mockImplementation(async () => {
      order.push('read');
      return USES_EDITOR;
    });
    vi.mocked(t.ui.promptInputs).mockImplementation(async () => {
      order.push('inputs');
      return {};
    });
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(order).toEqual(['editor', 'read', 'inputs']);
  });

  it('passes nothing to workflows that read neither root', async () => {
    const codeContext = fakeCapture();
    const t = setup({ text: USES_NONE, codeContext });
    const view = await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(codeContext.git).not.toHaveBeenCalled();
    expect(view?.context?.editor).toBeUndefined();
    expect(view?.context?.git).toBeUndefined();
  });

  it('reads git only for workflows that use it', async () => {
    const codeContext = fakeCapture();
    const t = setup({ text: USES_EDITOR, codeContext });
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(codeContext.git).not.toHaveBeenCalled();
    expect(t.commands.map((c) => c.command)).toEqual(['echo src/a.ts:3']);
  });

  it('uses an editor captured by the caller (Run workflow on selection)', async () => {
    const codeContext = fakeCapture();
    const t = setup({ text: USES_EDITOR, codeContext });
    const given: EditorContext = { selection: 'x', file: 'lib/b.py', language: 'python', line: 9 };
    await t.manager.whenFinished((await t.manager.start(t.uri, {}, { editor: given })) as string);
    expect(codeContext.editor).not.toHaveBeenCalled();
    expect(t.commands.map((c) => c.command)).toEqual(['echo lib/b.py:9']);
  });

  it('gives triggered runs no editor, except the saved file to save triggers', async () => {
    const codeContext = fakeCapture();
    const t = setup({ text: USES_EDITOR, codeContext, confirm: 'Run and remember' });
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    codeContext.editor.mockClear();
    const runAs = async (origin: RunOrigin) =>
      t.manager.whenFinished((await t.manager.start(t.uri, {}, { origin })) as string);

    await runAs({ kind: 'trigger', trigger: 'schedule' });
    await runAs({ kind: 'trigger', trigger: 'change', file: 'src/a.ts' });
    expect(codeContext.editor).not.toHaveBeenCalled();
    await runAs({ kind: 'trigger', trigger: 'save', file: 'src/other.ts' });
    await runAs({ kind: 'trigger', trigger: 'save', file: 'src/a.ts' });
    expect(t.commands.map((c) => c.command)).toEqual([
      'echo src/a.ts:3',
      'echo :0',
      'echo :0',
      'echo :0',
      'echo src/a.ts:3',
    ]);
  });

  it('runs with empty values without a capture service or an editor', async () => {
    const t = setup({ text: USES_BOTH });
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(t.commands[0].command.trim()).toBe('echo');

    const codeContext = fakeCapture();
    codeContext.editor.mockImplementation(() => {
      throw new Error('no window');
    });
    const failing = setup({ text: USES_EDITOR, codeContext });
    await failing.manager.whenFinished((await failing.manager.start(failing.uri)) as string);
    expect(failing.commands[0].command).toBe('echo :0');
    expect(failing.logLines).toContainEqual(expect.stringContaining('no window'));
  });

  it('git comes from the real workspace folder in worktree runs', async () => {
    const codeContext = fakeCapture();
    const text = `version: 1
name: Fix
isolation: worktree
steps:
  - id: show
    type: console
    run: echo \${{ git.branch }}
`;
    const t = setup({ text, codeContext });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    expect(codeContext.git).toHaveBeenCalledWith('/ws', expect.any(AbortSignal));
    expect(t.commands[0]).toMatchObject({ command: 'echo main', cwd: expect.stringContaining(runId) });
    expect(t.safety.order[0]).toBe('begin');
  });

  it('takes the git state before the snapshot', async () => {
    const order: string[] = [];
    const codeContext = fakeCapture(async () => {
      order.push('git');
      return GIT;
    });
    const t = setup({ text: USES_BOTH, codeContext });
    t.safety.safety.begin.mockImplementationOnce(async (options) => {
      order.push('begin');
      return { ...(await t.safety.safety.begin.getMockImplementation()!(options)) };
    });
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(order.slice(0, 2)).toEqual(['git', 'begin']);
  });

  it('ends the run as cancelled when it is cancelled while git is read', async () => {
    let started!: () => void;
    const reading = new Promise<void>((resolve) => (started = resolve));
    const codeContext = fakeCapture(
      (_root, signal) =>
        new Promise<GitContext>((resolve) => {
          started();
          signal?.addEventListener('abort', () => resolve(GIT));
        }),
    );
    const t = setup({ text: USES_BOTH, codeContext });
    const runId = (await t.manager.start(t.uri)) as string;
    await reading;
    t.manager.cancel(runId);
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('cancelled');
    expect(t.safety.safety.begin).not.toHaveBeenCalled();
    expect(t.commands).toEqual([]);
  });

  it('simulated runs get the editor, and git only in trusted workspaces', async () => {
    const trusted = fakeCapture();
    const t = setup({ text: USES_BOTH, codeContext: trusted });
    const view = await t.manager.whenFinished(
      (await t.manager.start(t.uri, {}, { simulate: true })) as string,
    );
    expect(view?.context?.editor).toEqual(EDITOR);
    expect(view?.context?.git).toEqual(GIT);

    const restricted = fakeCapture();
    const r = setup({ text: USES_BOTH, codeContext: restricted, trusted: false });
    const simulated = await r.manager.whenFinished(
      (await r.manager.start(r.uri, {}, { simulate: true })) as string,
    );
    expect(simulated?.context?.editor).toEqual(EDITOR);
    expect(simulated?.context?.git).toBeUndefined();
    expect(restricted.git).not.toHaveBeenCalled();
  });
});

describe('createRunManager project memory', () => {
  it('gives agents the memory of the run root with the journal and the secret values', async () => {
    const memory: ProjectMemory = { read: async () => undefined, append: async () => '- x' };
    const forRun = vi.fn((_root: string, _options: object) => memory);
    const service = { forRun } as unknown as MemoryService;
    const t = setup({ memory: service });
    await t.secrets.set('API_KEY', 'k-123456');
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(forRun).toHaveBeenCalledWith('/ws', { journal: t.safety.journal, secrets: ['k-123456'] });
    expect(vi.mocked(createEngineHost).mock.calls.at(-1)?.[0].memory).toBe(memory);
  });

  it('uses the worktree as the memory root of isolated runs', async () => {
    const forRun = vi.fn((_root: string, _options: object) => ({
      read: async () => undefined,
      append: async () => '',
    }));
    const text = `version: 1
name: Fix
isolation: worktree
steps:
  - id: build
    type: console
    run: npm run build
`;
    const t = setup({ text, memory: { forRun } as unknown as MemoryService });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    expect(forRun.mock.calls[0][0]).toBe(`/storage/worktrees/${runId}`);
  });

  it('runs agents without memory when there is no memory service', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    await flush();
    expect('memory' in (vi.mocked(createEngineHost).mock.calls.at(-1)?.[0] ?? {})).toBe(false);
    t.manager.cancel(runId);
    await t.manager.whenFinished(runId);
  });
});
