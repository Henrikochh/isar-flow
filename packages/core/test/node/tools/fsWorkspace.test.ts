import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsWorkspaceAdapter } from '../../../src/node/tools/fsWorkspace';
import { removeTempDir } from '../runner/fixtures';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar fs workspace-')));
});
afterEach(() => removeTempDir(root));

const write = (rel: string, content: string | Buffer) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

describe('createFsWorkspaceAdapter', () => {
  it('reads files as UTF-8 text', async () => {
    write('notes.md', 'Grüße\n');
    const workspace = createFsWorkspaceAdapter(root);
    expect(await workspace.readFile(path.join(root, 'notes.md'))).toBe('Grüße\n');
  });

  it('shows bytes that are not UTF-8 as replacement characters', async () => {
    write('latin1.txt', Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]));
    const text = await createFsWorkspaceAdapter(root).readFile(path.join(root, 'latin1.txt'));
    expect(text).toBe('Gr��e');
  });

  it('writes files and creates missing folders', async () => {
    const workspace = createFsWorkspaceAdapter(root);
    const file = path.join(root, 'src', 'deep', 'app.ts');
    await workspace.writeFile(file, 'export {};\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('export {};\n');
    await workspace.writeFile(file, 'changed\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('changed\n');
  });

  it('finds files below the root without node_modules and .git', async () => {
    write('src/a.ts', 'a');
    write('src/b.js', 'b');
    write('node_modules/pkg/index.ts', 'x');
    write('.git/config.ts', 'x');
    const workspace = createFsWorkspaceAdapter(root);
    expect(await workspace.findFiles('**/*.ts', 10)).toEqual(['src/a.ts']);
    expect(await workspace.findFiles('**/*', 1)).toHaveLength(1);
  });

  it('deletes files, checks existence and resolves real paths', async () => {
    write('gone.txt', 'x');
    const workspace = createFsWorkspaceAdapter(root);
    const file = path.join(root, 'gone.txt');
    expect(await workspace.exists(file)).toBe(true);
    expect(await workspace.realPath(file)).toBe(fs.realpathSync(file));
    await workspace.deleteFile?.(file);
    expect(await workspace.exists(file)).toBe(false);
    await expect(workspace.realPath(file)).rejects.toThrow();
  });

  it('reports file sizes, undefined for missing files', async () => {
    write('size.txt', 'four');
    const workspace = createFsWorkspaceAdapter(root);
    expect(await workspace.fileSize?.(path.join(root, 'size.txt'))).toBe(4);
    expect(await workspace.fileSize?.(path.join(root, 'missing.txt'))).toBeUndefined();
  });
});
