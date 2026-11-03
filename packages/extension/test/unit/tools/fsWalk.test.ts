import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walkFiles } from '../../../src/tools/fsWalk';
import { removeTempDir } from '../runner/fixtures';

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-walk-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-walk-outside-')));
  const write = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  };
  for (const rel of [
    'b.ts',
    'a.ts',
    'notes.md',
    'src/app.ts',
    'src/deep/util.ts',
    'node_modules/pkg/index.ts',
    'src/node_modules/x.ts',
    '.git/hooks/a.ts',
    '.hidden/conf.ts',
  ]) {
    write(rel);
  }
  fs.writeFileSync(path.join(outside, 'far.ts'), 'x');
  // 'junction' works without admin rights on Windows and is a plain symlink elsewhere.
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
});
afterAll(() => {
  removeTempDir(root);
  removeTempDir(outside);
});

describe('walkFiles', () => {
  it('lists matching files with forward slashes, without node_modules, .git and linked folders', async () => {
    expect(await walkFiles(root, '**/*.ts', 100)).toEqual([
      'a.ts',
      'b.ts',
      '.hidden/conf.ts',
      'src/app.ts',
      'src/deep/util.ts',
    ]);
  });

  it('matches the glob against the whole relative path', async () => {
    expect(await walkFiles(root, 'src/*.ts', 100)).toEqual(['src/app.ts']);
    expect(await walkFiles(root, '*.{md,ts}', 100)).toEqual(['a.ts', 'b.ts', 'notes.md']);
  });

  it('stops at max', async () => {
    expect(await walkFiles(root, '**/*', 2)).toHaveLength(2);
  });

  it('returns nothing for a folder that does not exist', async () => {
    expect(await walkFiles(path.join(root, 'missing'), '**/*', 10)).toEqual([]);
  });
});
