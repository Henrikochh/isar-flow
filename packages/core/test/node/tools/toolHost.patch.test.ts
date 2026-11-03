import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolWorkspace } from '../../../src/node/tools/toolContext';
import { createHarness, type Harness, type HarnessOptions } from './harness';

const lines = (...texts: string[]) => texts.join('\n');

let h: Harness;
function setup(options: HarnessOptions = {}): Harness {
  h = createHarness(options);
  h.write('src/a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  h.write('src/old.ts', 'export {};\n');
  return h;
}
afterEach(() => h.cleanup());

const exists = (rel: string) => fs.existsSync(path.join(h.root, rel));

const changeA = lines(
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 20;',
  ' const c = 3;',
);
const createC = lines(
  '--- /dev/null',
  '+++ b/src/c.ts',
  '@@ -0,0 +1,2 @@',
  '+export const c = 1;',
  '+export const d = 2;',
);
const deleteOld = lines('--- a/src/old.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-export {};');
const threeFiles = lines(deleteOld, createC, changeA);

describe('applyPatch', () => {
  it('changes, creates and deletes files and reports each in path order', async () => {
    setup();
    const result = await h.call('applyPatch', { patch: threeFiles });
    expect(result).toEqual({
      content: 'Patched 3 files: src/a.ts (+1 −1), src/c.ts (new, +2), src/old.ts (deleted, −1).',
    });
    expect(h.read('src/a.ts')).toBe('const a = 1;\nconst b = 20;\nconst c = 3;\n');
    expect(h.read('src/c.ts')).toBe('export const c = 1;\nexport const d = 2;\n');
    expect(exists('src/old.ts')).toBe(false);
  });

  it('adds notes for hunks that matched elsewhere or ignoring whitespace', async () => {
    setup();
    h.write('src/a.ts', 'const a = 1;\n\tconst b = 2;\nconst c = 3;\n');
    const patch = lines(
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -5,2 +5,2 @@',
      '  const b = 2;',
      '-const c = 3;',
      '+const c = 30;',
    );
    const result = await h.call('applyPatch', { patch });
    expect(result.content).toBe(
      lines(
        'Patched 1 file: src/a.ts (+1 −1).',
        'src/a.ts hunk 1 matched at line 2 instead of line 5.',
        'src/a.ts hunk 1 matched ignoring whitespace; the indentation was taken from the file.',
      ),
    );
    expect(h.read('src/a.ts')).toBe('const a = 1;\n\tconst b = 2;\nconst c = 30;\n');
  });

  it('keeps CRLF line endings for an LF patch', async () => {
    setup();
    h.write('src/a.ts', 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n');
    expect((await h.call('applyPatch', { patch: changeA })).isError).toBeFalsy();
    expect(h.read('src/a.ts')).toBe('const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n');
  });

  it('asks once with a summary and the patch, clipped to 800 characters', async () => {
    setup();
    h.answers.push('allow');
    await h.call('applyPatch', { patch: threeFiles }, { edits: 'ask' });
    expect(h.prompts).toEqual([
      {
        runId: 'run-1',
        stepId: 'fix',
        tool: 'applyPatch',
        summary: 'Patch 3 files (creates 1, deletes 1)',
        detail: threeFiles,
      },
    ]);

    h.answers.push('allow');
    const long = lines(changeA.replace('const b = 20;', `const b = '${'x'.repeat(900)}';`));
    h.write('src/a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    await h.call('applyPatch', { patch: long }, { edits: 'ask' });
    expect(h.prompts[1].summary).toBe('Patch src/a.ts');
    expect(h.prompts[1].detail).toHaveLength(800);
    expect(h.prompts[1].detail?.endsWith('…')).toBe(true);
  });

  it('names a single created file in the summary', async () => {
    setup();
    h.answers.push('allow');
    await h.call('applyPatch', { patch: createC }, { edits: 'ask' });
    expect(h.prompts[0].summary).toBe('Patch src/c.ts (creates 1)');
  });

  it('changes nothing and does not ask when one hunk fails', async () => {
    setup();
    const broken = lines(
      changeA,
      '--- a/src/old.ts',
      '+++ b/src/old.ts',
      '@@ -1 +1 @@',
      '-export { x };',
      '+export {};',
    );
    const result = await h.call('applyPatch', { patch: lines(createC, broken) }, { edits: 'ask' });
    expect(result).toEqual({
      isError: true,
      content:
        'src/old.ts hunk 1 (@@ -1 +1 @@): the context was not found near line 1; first differing line: ' +
        '"export { x };" (line 1 of the file: "export {};"). No file was changed. ' +
        'Read the file again and make a new patch.',
    });
    expect(h.prompts).toHaveLength(0);
    expect(h.read('src/a.ts')).toContain('const b = 2;');
    expect(exists('src/c.ts')).toBe(false);
  });

  it('lists every problem when several files fail', async () => {
    setup();
    const result = await h.call('applyPatch', {
      patch: lines(
        '--- /dev/null',
        '+++ b/src/a.ts',
        '@@ -0,0 +1 @@',
        '+x',
        '--- a/src/missing.ts',
        '+++ b/src/missing.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    });
    expect(result.content).toBe(
      lines(
        'The patch was not applied; no file was changed:',
        '- src/a.ts already exists, so the patch cannot create it. Read it and make a patch that changes it.',
        '- src/missing.ts does not exist. To create it, start its section with "--- /dev/null" and "+++ b/src/missing.ts".',
        'Read the files again and make a new patch.',
      ),
    );
  });

  it('refuses .git, paths outside the workspace and the folder itself without asking', async () => {
    setup();
    const patchFor = (file: string) => lines(`--- /dev/null`, `+++ ${file}`, '@@ -0,0 +1 @@', '+x');
    for (const target of ['.git/config', '../outside.txt', '.']) {
      const result = await h.call('applyPatch', { patch: patchFor(target) }, { edits: 'ask' });
      expect(result.isError, target).toBe(true);
    }
    expect((await h.call('applyPatch', { patch: patchFor('.git/hooks/pre-commit') })).content).toMatch(
      /inside \.git/,
    );
    expect(h.prompts).toHaveLength(0);
    expect(fs.existsSync(path.join(path.dirname(h.root), 'outside.txt'))).toBe(false);
  });

  it('refuses two sections that lead to the same file', async () => {
    setup();
    const patch = lines(
      changeA,
      '--- a/./src/a.ts',
      '+++ b/./src/a.ts',
      '@@ -3 +3 @@',
      '-const c = 3;',
      '+const c = 4;',
    );
    const result = await h.call('applyPatch', { patch });
    expect(result).toEqual({
      isError: true,
      content: 'The patch changes src/a.ts more than once. Put all changes to a file into one section.',
    });
  });

  it('explains empty and unreadable patches', async () => {
    setup();
    expect(await h.call('applyPatch', { patch: '  ' })).toEqual({
      isError: true,
      content: '"patch" is empty. Pass a unified diff.',
    });
    expect((await h.call('applyPatch', { patch: 'Change b to 20.' })).content).toMatch(
      /^The patch has no file changes/,
    );
    expect((await h.call('applyPatch', {})).content).toBe('"patch" is required.');
  });

  it('respects permission none and a denial', async () => {
    setup();
    const none = await h.call('applyPatch', { patch: changeA }, { edits: 'none', commands: 'auto' });
    expect(none.content).toMatch(/permissions\.edits/);
    h.answers.push('deny');
    const denied = await h.call('applyPatch', { patch: changeA }, { edits: 'ask' });
    expect(denied.content).toMatch(/declined this request \(Patch src\/a\.ts\)/);
    expect(h.read('src/a.ts')).toContain('const b = 2;');
  });

  it('stops asking after "allow for this run"', async () => {
    setup();
    h.answers.push('allowRun');
    await h.call('applyPatch', { patch: changeA }, { edits: 'ask' });
    await h.call('applyPatch', { patch: createC }, { edits: 'ask' });
    expect(h.prompts).toHaveLength(1);
    expect(exists('src/c.ts')).toBe(true);
  });

  it('rejects with the abort reason when the run is cancelled while asking', async () => {
    setup();
    h.prompt = () => new Promise(() => undefined);
    const pending = h.call('applyPatch', { patch: changeA }, { edits: 'ask' });
    h.controller.abort(new Error('Timed out after 5s'));
    await expect(pending).rejects.toThrow('Timed out after 5s');
    expect(h.read('src/a.ts')).toContain('const b = 2;');
  });

  it('plans again after asking and keeps a change made meanwhile', async () => {
    setup();
    h.prompt = async () => {
      h.write('src/a.ts', 'const a = 1;\nconst b = 99;\nconst c = 3;\n');
      return 'allow';
    };
    const result = await h.call('applyPatch', { patch: changeA }, { edits: 'ask' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^src\/a\.ts hunk 1 .*first differing line: "const b = 2;"/);
    expect(h.read('src/a.ts')).toBe('const a = 1;\nconst b = 99;\nconst c = 3;\n');
  });

  it('checks the paths again after asking, so a link made meanwhile cannot lead outside', async () => {
    setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'isar-outside-'));
    try {
      h.prompt = async () => {
        // 'junction' works without admin rights on Windows and is a plain symlink elsewhere.
        fs.symlinkSync(outside, path.join(h.root, 'late'), 'junction');
        return 'allow';
      };
      const patch = lines('--- /dev/null', '+++ b/late/x.txt', '@@ -0,0 +1 @@', '+x');
      const result = await h.call('applyPatch', { patch }, { edits: 'ask' });
      expect(result.isError).toBe(true);
      expect(fs.existsSync(path.join(outside, 'x.txt'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses to delete files before asking when the workspace cannot delete', async () => {
    setup({
      wrap: (workspace) => {
        const { deleteFile: _deleteFile, ...rest } = workspace;
        return rest;
      },
    });
    const result = await h.call('applyPatch', { patch: threeFiles }, { edits: 'ask' });
    expect(result).toEqual({
      isError: true,
      content:
        'Deleting files is not available here, so the patch was not applied. ' +
        'Leave out the sections with "+++ /dev/null".',
    });
    expect(h.prompts).toHaveLength(0);
    expect(exists('src/c.ts')).toBe(false);
    expect(exists('src/old.ts')).toBe(true);
  });

  it('refuses files that are too large to read', async () => {
    setup({
      wrap: (workspace): ToolWorkspace => ({
        ...workspace,
        fileSize: async (absPath) =>
          absPath.endsWith('a.ts') ? 25 * 1024 * 1024 : workspace.fileSize?.(absPath),
      }),
    });
    const result = await h.call('applyPatch', { patch: changeA });
    expect(result.content).toMatch(/^src\/a\.ts is too large to read \(25 MB\)\. No file was changed\./);
  });

  it('restores the files it already wrote when a later write fails', async () => {
    setup({
      wrap: (workspace): ToolWorkspace => ({
        ...workspace,
        writeFile: async (absPath, content) => {
          if (absPath.endsWith('c.ts')) throw new Error('disk full');
          return workspace.writeFile(absPath, content);
        },
      }),
    });
    const result = await h.call('applyPatch', { patch: threeFiles });
    expect(result).toEqual({
      isError: true,
      content:
        'Could not write src/c.ts: disk full. The files changed before it were restored (src/a.ts), ' +
        'so no file was changed.',
    });
    expect(h.read('src/a.ts')).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\n');
    expect(exists('src/old.ts')).toBe(true);
  });

  it('says which files could not be restored', async () => {
    let failRestore = false;
    setup({
      wrap: (workspace): ToolWorkspace => ({
        ...workspace,
        writeFile: async (absPath, content) => {
          if (absPath.endsWith('a.ts') && failRestore) throw new Error('locked');
          if (absPath.endsWith('a.ts')) failRestore = true;
          return workspace.writeFile(absPath, content);
        },
        deleteFile: async () => {
          throw new Error('in use');
        },
      }),
    });
    const result = await h.call('applyPatch', { patch: threeFiles });
    expect(result.content).toBe(
      'Could not delete src/old.ts: in use. Restoring the files changed before it failed: ' +
        'src/a.ts (locked), src/c.ts (in use). Check these files.',
    );
  });
});

describe('edit journal', () => {
  function journaled() {
    const order: string[] = [];
    const rel = (absPath: string) => path.relative(h.root, absPath).split(path.sep).join('/');
    setup({
      journal: {
        beforeWrite: async (absPath, stepId) => {
          order.push(
            `journal ${rel(absPath)} ${stepId} ${exists(rel(absPath)) ? h.read(rel(absPath)) : '(none)'}`,
          );
        },
      },
      wrap: (workspace): ToolWorkspace => ({
        ...workspace,
        writeFile: async (absPath, content) => {
          order.push(`write ${rel(absPath)}`);
          return workspace.writeFile(absPath, content);
        },
        deleteFile: async (absPath) => {
          order.push(`delete ${rel(absPath)}`);
          return workspace.deleteFile?.(absPath);
        },
      }),
    });
    return order;
  }

  it('is told about every patch write and delete with the step id, before it happens', async () => {
    const order = journaled();
    await h.call('applyPatch', { patch: threeFiles });
    expect(order).toEqual([
      'journal src/a.ts fix const a = 1;\nconst b = 2;\nconst c = 3;\n',
      'write src/a.ts',
      'journal src/c.ts fix (none)',
      'write src/c.ts',
      'journal src/old.ts fix export {};\n',
      'delete src/old.ts',
    ]);
  });

  it('is told about editFile and writeFile writes but not about reads or refused writes', async () => {
    const order = journaled();
    await h.call('readFile', { path: 'src/a.ts' });
    await h.call('listFiles', {});
    await h.call('editFile', { path: 'src/a.ts', oldText: 'const a = 1;', newText: 'const a = 10;' });
    await h.call('writeFile', { path: 'src/new.ts', content: 'x' });
    await h.call('writeFile', { path: 'src/denied.ts', content: 'x' }, { edits: 'none' });
    expect(order).toEqual([
      'journal src/a.ts fix const a = 1;\nconst b = 2;\nconst c = 3;\n',
      'write src/a.ts',
      'journal src/new.ts fix (none)',
      'write src/new.ts',
    ]);
  });

  it('gets the unsaved text of an open editor, which the write saves', async () => {
    const calls: unknown[][] = [];
    setup({
      journal: {
        beforeWrite: async (...args) => {
          calls.push(args);
        },
      },
      wrap: (workspace): ToolWorkspace => ({
        ...workspace,
        unsavedText: (absPath) => (absPath === path.join(h.root, 'src', 'a.ts') ? 'typed\n' : undefined),
      }),
    });
    await h.call('applyPatch', { patch: lines(changeA, deleteOld) });
    expect(calls).toEqual([
      [path.join(h.root, 'src', 'a.ts'), 'fix', 'typed\n'],
      [path.join(h.root, 'src', 'old.ts'), 'fix'],
    ]);
  });
});
