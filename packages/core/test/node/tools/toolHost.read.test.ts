import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.cleanup());

describe('readFile', () => {
  it('returns a header with path and line range, then the text', async () => {
    h.write('src/app.ts', 'one\ntwo\nthree\n');
    const result = await h.call('readFile', { path: 'src/app.ts' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('src/app.ts (lines 1-3 of 3)\none\ntwo\nthree');
  });

  it('reads a line range', async () => {
    h.write('src/app.ts', 'one\r\ntwo\r\nthree\r\nfour\r\n');
    const result = await h.call('readFile', { path: 'src/app.ts', startLine: 2, endLine: 3 });
    expect(result.content).toBe('src/app.ts (lines 2-3 of 4)\ntwo\nthree');
  });

  it('clamps endLine to the end of the file', async () => {
    h.write('a.txt', 'one\ntwo');
    const result = await h.call('readFile', { path: 'a.txt', startLine: 2, endLine: 99 });
    expect(result.content).toBe('a.txt (lines 2-2 of 2)\ntwo');
  });

  it('explains a start line past the end and a reversed range', async () => {
    h.write('a.txt', 'one\ntwo\n');
    const past = await h.call('readFile', { path: 'a.txt', startLine: 5 });
    expect(past.isError).toBe(true);
    expect(past.content).toMatch(/has 2 lines/);
    const reversed = await h.call('readFile', { path: 'a.txt', startLine: 2, endLine: 1 });
    expect(reversed.isError).toBe(true);
  });

  it('reports an empty file', async () => {
    h.write('empty.txt', '');
    expect((await h.call('readFile', { path: 'empty.txt' })).content).toBe('empty.txt (empty file)');
  });

  it('truncates after 200 KB and says how to continue', async () => {
    const line = 'x'.repeat(1023);
    h.write('big.txt', `${line}\n`.repeat(400));
    const result = await h.call('readFile', { path: 'big.txt' });
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeLessThanOrEqual(200 * 1024 + 500);
    expect(result.content.split('\n')[0]).toBe('big.txt (lines 1-200 of 400)');
    expect(result.content).toMatch(/Truncated at 200 KB\. Continue with startLine 201\./);
  });

  it('refuses binary files', async () => {
    h.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
    const result = await h.call('readFile', { path: 'logo.png' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/binary/);
  });

  it('reports missing files and folders', async () => {
    const missing = await h.call('readFile', { path: 'src/nope.ts' });
    expect(missing).toEqual({
      isError: true,
      content: expect.stringMatching(/^File not found: src\/nope\.ts/),
    });
    h.write('src/a.ts', '');
    const folder = await h.call('readFile', { path: 'src' });
    expect(folder.isError).toBe(true);
    expect(folder.content).toMatch(/folder/);
  });

  it('refuses paths outside the workspace', async () => {
    const result = await h.call('readFile', { path: '../../etc/passwd' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/);
  });

  it('returns invalid arguments as errors', async () => {
    const result = await h.call('readFile', { path: 42 });
    expect(result).toEqual({ isError: true, content: expect.stringMatching(/"path" must be a string/) });
  });
});

describe('listFiles', () => {
  beforeEach(() => {
    h.write('src/b.ts', '');
    h.write('src/a.ts', '');
    h.write('README.md', '');
    h.write('node_modules/pkg/index.js', '');
  });

  it('lists all files sorted without node_modules', async () => {
    const result = await h.call('listFiles', {});
    expect(result.content).toBe('README.md\nsrc/a.ts\nsrc/b.ts');
  });

  it('filters with a glob', async () => {
    expect((await h.call('listFiles', { glob: 'src/**/*.ts' })).content).toBe('src/a.ts\nsrc/b.ts');
  });

  it('says when nothing matches', async () => {
    expect((await h.call('listFiles', { glob: '**/*.py' })).content).toBe('No files match **/*.py.');
  });

  it('stops at 500 paths', async () => {
    for (let i = 0; i < 510; i++) h.write(`many/f${String(i).padStart(3, '0')}.txt`, '');
    const result = await h.call('listFiles', { glob: 'many/*.txt' });
    const lines = result.content.split('\n');
    expect(lines.filter((l) => l.startsWith('many/'))).toHaveLength(500);
    expect(result.content).toMatch(/Showing the first 500/);
  });

  it('refuses globs that leave the workspace', async () => {
    expect((await h.call('listFiles', { glob: '../**/*' })).isError).toBe(true);
    expect((await h.call('listFiles', { glob: '/etc/*' })).isError).toBe(true);
  });
});

describe('searchText', () => {
  beforeEach(() => {
    h.write('src/a.ts', 'const answer = 42;\n  // TODO: tidy up\n');
    h.write('src/b.ts', 'export const todo = [];\nconsole.log("TODO later");\n');
    h.write('docs/notes.md', 'TODO in docs\n');
  });

  it('finds plain text as "path:line: text"', async () => {
    const result = await h.call('searchText', { query: 'TODO' });
    expect(result.content.split('\n')).toEqual([
      'docs/notes.md:1: TODO in docs',
      'src/a.ts:2: // TODO: tidy up',
      'src/b.ts:2: console.log("TODO later");',
    ]);
  });

  it('supports regular expressions and globs', async () => {
    const result = await h.call('searchText', { query: '^export\\s+const', isRegex: true, glob: 'src/**' });
    expect(result.content).toBe('src/b.ts:1: export const todo = [];');
  });

  it('returns an invalid regular expression as an error', async () => {
    const result = await h.call('searchText', { query: '(unclosed', isRegex: true });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Invalid regular expression/);
  });

  it('skips binary and large files', async () => {
    h.write('bin/data.bin', Buffer.concat([Buffer.from('TODO'), Buffer.from([0, 1, 2])]));
    h.write('big/huge.txt', `TODO\n${'y'.repeat(1024 * 1024)}`);
    const result = await h.call('searchText', { query: 'TODO' });
    expect(result.content).not.toMatch(/data\.bin|huge\.txt/);
  });

  it('stops after 200 matches', async () => {
    h.write('many.txt', 'match\n'.repeat(250));
    const result = await h.call('searchText', { query: 'match', glob: 'many.txt' });
    expect(result.content.split('\n').filter((l) => l.startsWith('many.txt:'))).toHaveLength(200);
    expect(result.content).toMatch(/Stopped after 200 matches/);
  });

  it('says when nothing matches', async () => {
    expect((await h.call('searchText', { query: 'nothing-here' })).content).toBe(
      'No matches for "nothing-here".',
    );
  });
});

describe('gitDiff', () => {
  it('runs git diff in the workspace root with the default shell, without asking', async () => {
    h.runCommand = async () => ({
      exitCode: 0,
      stdout: 'diff --git a/x b/x\n',
      stderr: '',
      output: '',
      timedOut: false,
    });
    const result = await h.call('gitDiff', {}, { edits: 'none', commands: 'none' });
    expect(result).toEqual({ content: 'diff --git a/x b/x\n' });
    expect(h.prompts).toHaveLength(0);
    expect(h.commands[0]).toMatchObject({ shell: 'auto', cwd: h.root });
    expect(h.commands[0].command).toMatch(/^git diff\b/);
    expect(h.commands[0].command).not.toMatch(/--staged/);
  });

  it('shows staged changes', async () => {
    await h.call('gitDiff', { staged: true });
    expect(h.commands[0].command).toMatch(/^git diff --staged\b/);
  });

  it('says when there are no changes', async () => {
    h.runCommand = async () => ({ exitCode: 0, stdout: '', stderr: '', output: '', timedOut: false });
    expect((await h.call('gitDiff', {})).content).toBe('No unstaged changes.');
    expect((await h.call('gitDiff', { staged: true })).content).toBe('No staged changes.');
  });

  it('returns git failures as errors', async () => {
    h.runCommand = async () => ({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository\n',
      output: 'fatal: not a git repository\n',
      timedOut: false,
    });
    const result = await h.call('gitDiff', {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/exit code 128.*not a git repository/s);
  });

  it('caps the diff at 200 KB', async () => {
    h.runCommand = async () => ({
      exitCode: 0,
      stdout: '+line\n'.repeat(60_000),
      stderr: '',
      output: '',
      timedOut: false,
    });
    const result = await h.call('gitDiff', {});
    expect(result.content.length).toBeLessThan(200 * 1024 + 200);
    expect(result.content).toMatch(/Truncated at 200 KB/);
  });
});

describe('unknown tools', () => {
  it('returns an error result', async () => {
    const result = await h.call('deleteEverything', {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Unknown tool/);
  });
});
