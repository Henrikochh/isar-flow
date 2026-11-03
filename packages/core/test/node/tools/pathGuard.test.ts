import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveInWorkspace, resolveInWorkspaceReal } from '../../../src/node/tools/pathGuard';
import { removeTempDir } from '../runner/fixtures';

const OUTSIDE = /outside the workspace/;

describe('resolveInWorkspace (POSIX paths)', () => {
  const root = '/work/repo';
  const resolve = (input: string) => resolveInWorkspace(root, input, 'linux');

  it('resolves relative paths inside the root', () => {
    expect(resolve('src/app.ts')).toBe('/work/repo/src/app.ts');
    expect(resolve('./src/../README.md')).toBe('/work/repo/README.md');
    expect(resolve('.')).toBe('/work/repo');
  });

  it('accepts absolute paths inside the root', () => {
    expect(resolve('/work/repo/src/a.ts')).toBe('/work/repo/src/a.ts');
  });

  it.each(['../outside', '../../etc/passwd', 'src/../../repo2/x', '/etc/passwd', '/work/repository/x', '..'])(
    'refuses %s',
    (input) => {
      expect(() => resolve(input)).toThrow(OUTSIDE);
    },
  );

  it('refuses empty paths and NUL characters', () => {
    expect(() => resolve('')).toThrow(/empty/);
    expect(() => resolve('a\0b')).toThrow();
  });
});

describe('resolveInWorkspace (Windows paths)', () => {
  const root = 'C:\\work\\repo';
  const resolve = (input: string) => resolveInWorkspace(root, input, 'win32');

  it('resolves forward and back slashes inside the root', () => {
    expect(resolve('src/app.ts')).toBe('C:\\work\\repo\\src\\app.ts');
    expect(resolve('src\\app.ts')).toBe('C:\\work\\repo\\src\\app.ts');
    expect(resolveInWorkspace('C:\\work\\repo\\', 'a.ts', 'win32')).toBe('C:\\work\\repo\\a.ts');
  });

  it('compares case-insensitively', () => {
    expect(resolve('c:\\WORK\\Repo\\src\\a.ts')).toBe('c:\\WORK\\Repo\\src\\a.ts');
    expect(resolve('\\work\\repo\\a.ts')).toBe('C:\\work\\repo\\a.ts');
  });

  it.each([
    '..\\..\\Windows\\win.ini',
    'src/..\\..\\x',
    'D:\\work\\repo\\a.ts',
    'd:/x',
    '\\Windows\\win.ini',
    'C:\\work\\repository\\a.ts',
  ])('refuses %s', (input) => {
    expect(() => resolve(input)).toThrow(OUTSIDE);
  });

  it.each([
    '\\\\server\\share\\a.ts',
    '//server/share/a.ts',
    '\\\\?\\C:\\work\\repo\\a.ts',
    '\\\\.\\pipe\\x',
  ])('refuses network and device path %s', (input) => {
    expect(() => resolve(input)).toThrow(/not allowed/);
  });

  it('refuses drive-relative paths, reserved device names and alternate streams', () => {
    expect(() => resolve('C:secret.txt')).toThrow(/not allowed/);
    expect(() => resolve('src/con.txt')).toThrow(/not allowed/);
    expect(() => resolve('NUL')).toThrow(/not allowed/);
    expect(() => resolve('file.txt:hidden')).toThrow(/not allowed/);
  });
});

describe('resolveInWorkspaceReal', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-guard-')));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'inside'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'inside', 'file.txt'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  // 'junction' works without admin rights on Windows and is ignored (plain symlink) elsewhere.
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  fs.symlinkSync(path.join(root, 'inside'), path.join(root, 'inlink'), 'junction');
  fs.symlinkSync(path.join(base, 'missing-target'), path.join(root, 'dangling'), 'junction');
  fs.symlinkSync(root, path.join(base, 'rootlink'), 'junction');
  afterAll(() => removeTempDir(base));

  const realPath = (p: string) => fs.promises.realpath(p);

  it('allows existing and new files inside the root', async () => {
    await expect(resolveInWorkspaceReal(root, 'inside/file.txt', realPath)).resolves.toBe(
      path.join(root, 'inside', 'file.txt'),
    );
    await expect(resolveInWorkspaceReal(root, 'inside/new/deep/file.txt', realPath)).resolves.toBe(
      path.join(root, 'inside', 'new', 'deep', 'file.txt'),
    );
  });

  it('refuses a junction or symlink that leads outside', async () => {
    await expect(resolveInWorkspaceReal(root, 'escape/secret.txt', realPath)).rejects.toThrow(OUTSIDE);
    await expect(resolveInWorkspaceReal(root, 'escape/new-file.txt', realPath)).rejects.toThrow(OUTSIDE);
    await expect(resolveInWorkspaceReal(root, 'escape', realPath)).rejects.toThrow(OUTSIDE);
  });

  it('allows links that stay inside the root', async () => {
    await expect(resolveInWorkspaceReal(root, 'inlink/file.txt', realPath)).resolves.toBe(
      path.join(root, 'inlink', 'file.txt'),
    );
  });

  it('refuses paths through a broken link', async () => {
    await expect(resolveInWorkspaceReal(root, 'dangling/x.txt', realPath)).rejects.toThrow(/broken/);
  });

  it('works when the root itself is reached through a link', async () => {
    const linkedRoot = path.join(base, 'rootlink');
    await expect(resolveInWorkspaceReal(linkedRoot, 'inside/file.txt', realPath)).resolves.toBe(
      path.join(linkedRoot, 'inside', 'file.txt'),
    );
  });

  it('still applies the lexical check', async () => {
    await expect(resolveInWorkspaceReal(root, '../outside/secret.txt', realPath)).rejects.toThrow(OUTSIDE);
  });
});
