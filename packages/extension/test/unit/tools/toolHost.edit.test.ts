import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.write('src/app.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
});
afterEach(() => h.cleanup());

describe('editFile', () => {
  it('replaces exactly one occurrence', async () => {
    const result = await h.call('editFile', {
      path: 'src/app.ts',
      oldText: 'const b = 2;',
      newText: 'const b = 20;\nconst d = 4;',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('Edited src/app.ts: replaced 1 line with 2 lines.');
    expect(h.read('src/app.ts')).toBe('const a = 1;\nconst b = 20;\nconst d = 4;\nconst c = 3;\n');
  });

  it('explains when oldText is missing', async () => {
    const result = await h.call('editFile', { path: 'src/app.ts', oldText: 'const z', newText: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^oldText was not found in src\/app\.ts/);
  });

  it('explains when oldText occurs more than once', async () => {
    const result = await h.call('editFile', { path: 'src/app.ts', oldText: 'const', newText: 'let' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^oldText occurs 3 times in src\/app\.ts; include more surrounding lines/);
    expect(h.read('src/app.ts')).toContain('const a');
  });

  it('matches LF text against a CRLF file and keeps CRLF', async () => {
    h.write('win.txt', 'one\r\ntwo\r\nthree\r\n');
    const result = await h.call('editFile', { path: 'win.txt', oldText: 'one\ntwo', newText: 'uno\ndos' });
    expect(result.isError).toBeFalsy();
    expect(h.read('win.txt')).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('refuses an empty oldText and missing files', async () => {
    expect((await h.call('editFile', { path: 'src/app.ts', oldText: '', newText: 'x' })).isError).toBe(true);
    const missing = await h.call('editFile', { path: 'src/new.ts', oldText: 'a', newText: 'b' });
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/File not found.*writeFile/s);
  });

  it('refuses paths outside the workspace without asking', async () => {
    const result = await h.call(
      'editFile',
      { path: '../x.ts', oldText: 'a', newText: 'b' },
      { edits: 'ask' },
    );
    expect(result.isError).toBe(true);
    expect(h.prompts).toHaveLength(0);
  });
});

describe('writeFile', () => {
  it('creates files with their folders', async () => {
    const result = await h.call('writeFile', { path: 'src/deep/new.ts', content: 'export {};\n' });
    expect(result.content).toBe('Created src/deep/new.ts (1 line).');
    expect(h.read('src/deep/new.ts')).toBe('export {};\n');
  });

  it('overwrites existing files', async () => {
    const result = await h.call('writeFile', { path: 'src/app.ts', content: 'a\nb\n' });
    expect(result.content).toBe('Wrote src/app.ts (2 lines).');
    expect(h.read('src/app.ts')).toBe('a\nb\n');
  });

  it('refuses to write inside .git', async () => {
    const result = await h.call('writeFile', { path: '.git/config', content: 'x' });
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(h.root, '.git', 'config'))).toBe(false);
  });

  it('refuses to write into .git through a link inside the workspace', async () => {
    fs.mkdirSync(path.join(h.root, '.git'));
    // 'junction' works without admin rights on Windows and is a plain symlink elsewhere.
    fs.symlinkSync(path.join(h.root, '.git'), path.join(h.root, 'gitlink'), 'junction');
    const write = await h.call('writeFile', { path: 'gitlink/config', content: 'x' });
    expect(write.isError).toBe(true);
    expect(write.content).toMatch(/inside \.git/);
    h.write('.git/HEAD', 'ref: refs/heads/main\n');
    const edit = await h.call('editFile', { path: 'gitlink/HEAD', oldText: 'main', newText: 'evil' });
    expect(edit.isError).toBe(true);
    expect(fs.readdirSync(path.join(h.root, '.git'))).toEqual(['HEAD']);
    expect(h.read('.git/HEAD')).toBe('ref: refs/heads/main\n');
  });

  it.runIf(process.platform === 'win32')('refuses the 8.3 short name of .git', async () => {
    fs.mkdirSync(path.join(h.root, '.git'));
    // Short names are on by default on system drives; skip the check where the volume has them off.
    if (!fs.existsSync(path.join(h.root, 'GIT~1'))) return;
    const result = await h.call('writeFile', { path: 'GIT~1/config', content: 'x' });
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(h.root, '.git', 'config'))).toBe(false);
  });

  it('refuses .git with trailing dots or spaces, which Windows drops', async () => {
    for (const input of ['.git./config', '.GIT ./hooks/pre-commit']) {
      const result = await h.call('writeFile', { path: input, content: 'x' });
      expect(result.isError, input).toBe(true);
      expect(result.content).toMatch(/inside \.git/);
    }
  });
});

describe('edit permissions', () => {
  it('"none" refuses and names the setting', async () => {
    const result = await h.call(
      'writeFile',
      { path: 'x.txt', content: 'x' },
      { edits: 'none', commands: 'auto' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/permissions\.edits/);
    expect(h.prompts).toHaveLength(0);
    expect(fs.existsSync(path.join(h.root, 'x.txt'))).toBe(false);
  });

  it('"ask" asks with a summary and applies the edit when allowed', async () => {
    h.answers.push('allow');
    const result = await h.call(
      'editFile',
      { path: 'src/app.ts', oldText: 'const a = 1;', newText: 'const a = 10;' },
      { edits: 'ask' },
    );
    expect(result.isError).toBeFalsy();
    expect(h.prompts).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        stepId: 'fix',
        tool: 'editFile',
        summary: 'Edit src/app.ts',
      }),
    ]);
    expect(h.prompts[0].detail).toContain('const a = 10;');
    expect(h.read('src/app.ts')).toContain('const a = 10;');
  });

  it('"ask" returns a denial as an error and leaves the file alone', async () => {
    h.answers.push('deny');
    const result = await h.call('writeFile', { path: 'src/app.ts', content: 'gone' }, { edits: 'ask' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/declined/);
    expect(h.prompts[0].summary).toBe('Overwrite src/app.ts');
    expect(h.read('src/app.ts')).toContain('const a');
  });

  it('"allow for this run" stops asking for that tool only', async () => {
    h.answers.push('allowRun', 'allow');
    await h.call('writeFile', { path: 'one.txt', content: '1' }, { edits: 'ask' });
    await h.call('writeFile', { path: 'two.txt', content: '2' }, { edits: 'ask' });
    expect(h.prompts.map((p) => p.summary)).toEqual(['Create one.txt']);
    await h.call('editFile', { path: 'one.txt', oldText: '1', newText: '11' }, { edits: 'ask' });
    expect(h.prompts.map((p) => p.tool)).toEqual(['writeFile', 'editFile']);
    expect(h.read('two.txt')).toBe('2');
  });

  it('checks the path again after asking, so a link made meanwhile cannot lead outside or into .git', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'isar-outside-'));
    fs.mkdirSync(path.join(h.root, '.git'));
    try {
      // 'junction' works without admin rights on Windows and is a plain symlink elsewhere.
      h.prompt = async () => {
        fs.symlinkSync(outside, path.join(h.root, 'late'), 'junction');
        return 'allow';
      };
      const escaped = await h.call('writeFile', { path: 'late/x.txt', content: 'x' }, { edits: 'ask' });
      expect(escaped.isError).toBe(true);
      expect(fs.existsSync(path.join(outside, 'x.txt'))).toBe(false);

      h.prompt = async () => {
        fs.symlinkSync(path.join(h.root, '.git'), path.join(h.root, 'gitlate'), 'junction');
        return 'allow';
      };
      const git = await h.call('writeFile', { path: 'gitlate/config', content: 'x' }, { edits: 'ask' });
      expect(git.isError).toBe(true);
      expect(fs.readdirSync(path.join(h.root, '.git'))).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('asks when no permission is configured', async () => {
    h.answers.push('allow');
    await h.call('writeFile', { path: 'x.txt', content: 'x' }, {});
    expect(h.prompts).toHaveLength(1);
  });

  it('does not ask before a doomed edit', async () => {
    const result = await h.call(
      'editFile',
      { path: 'src/app.ts', oldText: 'nope', newText: 'x' },
      { edits: 'ask' },
    );
    expect(result.isError).toBe(true);
    expect(h.prompts).toHaveLength(0);
  });
});
