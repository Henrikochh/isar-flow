import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepIO, ToolHost } from '@isar-flow/core';
import type { ConsoleRunOptions } from '../../../src/contracts';
import { createToolHostFactory, type ToolHostFactoryDeps } from '../../../src/tools/toolHostFactory';
import { removeTempDir } from '../runner/fixtures';
import { consoleResult, createFsWorkspace } from './harness';

let base: string;
let first: string;
let second: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-roots-')));
  first = path.join(base, 'first');
  second = path.join(base, 'second');
  for (const [folder, text] of [
    [first, 'in first'],
    [second, 'in second'],
  ]) {
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'notes.txt'), text);
  }
});
afterEach(() => removeTempDir(base));

function setup(defaultRoot: () => string | undefined = () => first) {
  const commands: ConsoleRunOptions[] = [];
  const deps: ToolHostFactoryDeps = {
    defaultRoot,
    workspace: vi.fn((root: string) => createFsWorkspace(root)),
    defaultShell: vi.fn((_root: string): string => 'bash'),
    runCommand: async (options) => {
      commands.push(options);
      return consoleResult();
    },
    prompt: async () => 'deny',
  };
  return { factory: createToolHostFactory(deps), deps, commands };
}

const io: StepIO = { runId: 'r1', stepId: 'ask', signal: new AbortController().signal, log: () => undefined };
const call = (host: ToolHost, name: string, args: Record<string, unknown> = {}) =>
  host.execute({ name, args }, io, { edits: 'none', commands: 'none' });

describe('tool host factory', () => {
  it("gives agents tools in the workflow's own folder", async () => {
    const { factory, deps, commands } = setup();
    const host = factory('r1', second);
    expect((await call(host, 'readFile', { path: 'notes.txt' })).content).toContain('in second');
    expect(deps.workspace).toHaveBeenCalledWith(second);
    expect(deps.defaultShell).toHaveBeenCalledWith(second);

    await call(host, 'gitDiff');
    expect(commands[0]).toMatchObject({ cwd: second, shell: 'bash' });
  });

  it('keeps the tools inside that folder', async () => {
    const { factory } = setup();
    const result = await call(factory('r1', second), 'readFile', { path: '../first/notes.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('in first');
  });

  it('uses the first workspace folder when no folder is given', async () => {
    const { factory } = setup();
    expect((await call(factory('r1'), 'readFile', { path: 'notes.txt' })).content).toContain('in first');
  });

  it('falls back to the automatic shell when the setting names an unknown one', async () => {
    const { factory, deps, commands } = setup();
    vi.mocked(deps.defaultShell).mockReturnValue('zsh');
    await call(factory('r1'), 'gitDiff');
    expect(commands[0]).toMatchObject({ shell: 'auto' });
  });

  it('passes the run journal to the host, which reports writes with the step id', async () => {
    const { factory } = setup();
    const journal = { beforeWrite: vi.fn(async (_absPath: string, _stepId: string) => undefined) };
    const write = (host: ToolHost) =>
      host.execute({ name: 'writeFile', args: { path: 'out.txt', content: 'x' } }, io, { edits: 'auto' });

    expect((await write(factory('r1', second, { journal }))).isError).toBeFalsy();
    expect(journal.beforeWrite).toHaveBeenCalledWith(path.join(second, 'out.txt'), 'ask');

    journal.beforeWrite.mockClear();
    await write(factory('r2', second));
    await write(factory('r3', second, {}));
    expect(journal.beforeWrite).not.toHaveBeenCalled();
  });

  it('refuses every tool call when no folder is open', async () => {
    const { factory, deps } = setup(() => undefined);
    const result = await call(factory('r1'), 'readFile', { path: 'notes.txt' });
    expect(result).toEqual({
      isError: true,
      content: 'Agent tools need an open folder. Open a folder in VS Code and run again.',
    });
    expect(deps.workspace).not.toHaveBeenCalled();
  });
});
