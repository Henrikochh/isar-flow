import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_OUTSIDE, memoryFileInside } from '../../../src/node/tools/memoryPath';
import { removeTempDir } from '../runner/fixtures';

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

describe('memoryFileInside', () => {
  it('returns the memory file of the folder, also before it exists', async () => {
    const root = tempDir('isar-memory-path-');
    const file = path.join(root, '.isarflow', 'memory.md');
    expect(await memoryFileInside(root)).toBe(file);
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '# Project memory\n');
    expect(await memoryFileInside(root)).toBe(file);
  });

  it('refuses a .isarflow folder that a link or junction leads outside the workspace', async () => {
    const root = tempDir('isar-memory-path-');
    const outside = tempDir('isar-memory-outside-');
    fs.writeFileSync(path.join(outside, 'memory.md'), 'not the project memory');
    // 'junction' works without admin rights on Windows and is a plain symlink elsewhere.
    fs.symlinkSync(outside, path.join(root, '.isarflow'), 'junction');
    await expect(memoryFileInside(root)).rejects.toThrow(MEMORY_OUTSIDE);
    expect(MEMORY_OUTSIDE).toBe(
      ".isarflow/memory.md leads outside the workspace folder through a symbolic link or junction, so it isn't used.",
    );
  });

  it('accepts a link that stays inside the workspace', async () => {
    const root = tempDir('isar-memory-path-');
    fs.mkdirSync(path.join(root, 'notes'));
    fs.symlinkSync(path.join(root, 'notes'), path.join(root, '.isarflow'), 'junction');
    expect(await memoryFileInside(root)).toBe(path.join(root, '.isarflow', 'memory.md'));
  });
});
