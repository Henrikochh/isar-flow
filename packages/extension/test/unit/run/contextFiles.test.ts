import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_LIMITS,
  createContextFileReader,
  createWorkspaceContextReader,
} from '../../../src/run/contextFiles';
import { removeTempDir } from '../runner/fixtures';

const signal = () => new AbortController().signal;

describe('createContextFileReader', () => {
  it('reads the files of all globs once, in order', async () => {
    const find = vi.fn(async (glob: string, _max: number) =>
      glob === 'src/*.ts' ? ['src/a.ts', 'src/b.ts'] : ['src/b.ts', 'README.md'],
    );
    const read = vi.fn(async (path: string) => `content of ${path}`);
    const files = await createContextFileReader(find, read)(['src/*.ts', '*.md'], signal());
    expect(files).toEqual([
      { path: 'src/a.ts', content: 'content of src/a.ts' },
      { path: 'src/b.ts', content: 'content of src/b.ts' },
      { path: 'README.md', content: 'content of README.md' },
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(find.mock.calls[0][1]).toBeLessThanOrEqual(CONTEXT_LIMITS.files + 1);
  });

  it('attaches at most 20 files and says so', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `f${i}.txt`);
    const files = await createContextFileReader(
      async (_glob, max) => paths.slice(0, max),
      async () => 'x',
    )(['*.txt'], signal());
    expect(files).toHaveLength(20);
    expect(files[19].content).toMatch(/more matching files were not attached/i);
  });

  it('truncates files over 100 KB with a note', async () => {
    const big = 'a'.repeat(CONTEXT_LIMITS.fileChars + 500);
    const [file] = await createContextFileReader(
      async () => ['big.txt'],
      async () => big,
    )(['big.txt'], signal());
    expect(file.content.startsWith('a'.repeat(CONTEXT_LIMITS.fileChars))).toBe(true);
    expect(file.content).toContain('Truncated');
    expect(file.content.length).toBeLessThan(CONTEXT_LIMITS.fileChars + 200);
  });

  it('stops at 400 KB in total', async () => {
    const paths = ['1.txt', '2.txt', '3.txt', '4.txt', '5.txt', '6.txt'];
    const files = await createContextFileReader(
      async () => paths,
      async () => 'b'.repeat(90 * 1024),
    )(['*.txt'], signal());
    const total = files.reduce((sum, f) => sum + f.content.replace(/\n\[Isar Flow:[^\]]*\]/g, '').length, 0);
    expect(total).toBeLessThanOrEqual(CONTEXT_LIMITS.totalChars);
    expect(files.length).toBeLessThan(paths.length);
    expect(files[files.length - 1].content).toContain('Isar Flow:');
  });

  it('marks unreadable and binary files instead of attaching them', async () => {
    const files = await createContextFileReader(
      async () => ['gone.txt', 'img.png'],
      async (path) => {
        if (path === 'gone.txt') throw new Error('ENOENT');
        return 'PNG\u0000\u0001';
      },
    )(['*'], signal());
    expect(files[0].content).toContain('could not be read');
    expect(files[1].content).toContain('binary');
  });

  it('rejects when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createContextFileReader(
        async () => ['a'],
        async () => 'x',
      )(['a'], controller.signal),
    ).rejects.toThrow();
  });

  it('returns nothing for no globs', async () => {
    const find = vi.fn(async () => []);
    expect(await createContextFileReader(find, async () => '')([], signal())).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});

describe('createWorkspaceContextReader', () => {
  it('does not attach files that a link or junction leads to outside the folder', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-context-')));
    try {
      const root = path.join(base, 'ws');
      const outside = path.join(base, 'private');
      fs.mkdirSync(root);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
      fs.writeFileSync(path.join(root, 'notes.md'), 'notes');
      // 'junction' works without admin rights on Windows and is a plain symlink elsewhere.
      fs.symlinkSync(outside, path.join(root, 'docs'), 'junction');
      const read = createWorkspaceContextReader(root, {
        findFiles: async () => ['docs/id_rsa', 'notes.md'],
        readFile: (absPath) => fs.promises.readFile(absPath, 'utf8'),
        realPath: (absPath) => fs.promises.realpath(absPath),
      });
      const files = await read(['**/*'], signal());
      expect(files[1]).toEqual({ path: 'notes.md', content: 'notes' });
      expect(files[0].path).toBe('docs/id_rsa');
      expect(files[0].content).not.toContain('PRIVATE KEY');
      expect(files[0].content).toMatch(/outside the workspace folder/);
    } finally {
      removeTempDir(base);
    }
  });
});
