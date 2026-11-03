import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openEditJournal } from '../../../src/safety/editJournal';
import { hashOf } from '../../../src/safety/util';
import { removeTempDirs, silentLog, tempDir, writeFiles } from './gitRepo';

afterAll(removeTempDirs);

function setup(options: Partial<Parameters<typeof openEditJournal>[0]> = {}) {
  const root = tempDir('isar-journal-root-');
  const dir = path.join(tempDir('isar-journal-store-'), 'reviews', 'run-1');
  const log = silentLog();
  let clock = 1000;
  const journal = openEditJournal({ runId: 'run-1', root, dir, log, now: () => clock++, ...options });
  return { root, dir, log, journal };
}

const text = (bytes: Uint8Array | null | undefined) =>
  bytes === null || bytes === undefined ? bytes : Buffer.from(bytes).toString('utf8');

describe('edit journal', () => {
  it('keeps the original of the first write per file and every block that wrote it', async () => {
    const { root, journal } = setup();
    writeFiles(root, { 'src/app.ts': 'original\r\n' });
    const app = path.join(root, 'src', 'app.ts');
    await journal.beforeWrite(app, 'implement');
    fs.writeFileSync(app, 'changed once');
    await journal.beforeWrite(app, 'fix');
    await journal.beforeWrite(app, 'implement');
    fs.writeFileSync(app, 'changed twice');
    await journal.beforeWrite(path.join(root, 'new.md'), 'docs');

    expect(journal.entries()).toEqual([
      { path: 'src/app.ts', stepIds: ['implement', 'fix'], existed: true, originalStored: true, at: 1000 },
      { path: 'new.md', stepIds: ['docs'], existed: false, originalStored: true, at: 1001 },
    ]);
    expect(text(await journal.original('src/app.ts'))).toBe('original\r\n');
    expect(await journal.original('new.md')).toBeNull();
    expect(await journal.original('never-written.txt')).toBeUndefined();
  });

  it('keeps the unsaved text of an open editor as the original, since the write saves it', async () => {
    const { root, dir, journal } = setup();
    writeFiles(root, { 'a.txt': 'on disk\n' });
    const file = path.join(root, 'a.txt');
    await journal.beforeWrite(file, 'one', 'on disk\ntyped\n');
    await journal.beforeWrite(file, 'two', 'later text');
    expect(text(await journal.original('a.txt'))).toBe('on disk\ntyped\n');
    expect(journal.hadUnsavedChanges('a.txt')).toBe(true);
    expect(journal.entries()).toEqual([
      { path: 'a.txt', stepIds: ['one', 'two'], existed: true, originalStored: true, at: 1000 },
    ]);

    const reopened = openEditJournal({ runId: 'run-1', root, dir, log: silentLog() });
    expect(text(await reopened.original('a.txt'))).toBe('on disk\ntyped\n');
    expect(reopened.hadUnsavedChanges('a.txt')).toBe(true);
    expect(reopened.hadUnsavedChanges('b.txt')).toBe(false);
  });

  it('keeps the byte order mark of the file on disk with unsaved text', async () => {
    const { root, journal } = setup();
    writeFiles(root, { 'bom.txt': Buffer.from([0xef, 0xbb, 0xbf, 0x61]) });
    await journal.beforeWrite(path.join(root, 'bom.txt'), 's', 'typed');
    expect([...((await journal.original('bom.txt')) ?? [])]).toEqual([
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from('typed'),
    ]);
  });

  it('never marks a file as new when it could not be checked', async () => {
    const { root, journal, log } = setup();
    writeFiles(root, { 'locked.txt': 'precious' });
    const locked = path.join(root, 'locked.txt');
    const realLstat = fs.promises.lstat;
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (file, ...rest) => {
      if (file === locked)
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return realLstat(file, ...rest);
    });
    try {
      await journal.beforeWrite(locked, 's');
    } finally {
      lstat.mockRestore();
    }
    // A revert of a file it thinks the run created would delete it.
    expect(journal.entries()[0]).toMatchObject({ path: 'locked.txt', existed: true, originalStored: false });
    expect(await journal.original('locked.txt')).toBeUndefined();
    expect(log.lines.join('\n')).toMatch(/Could not check locked\.txt/);
  });

  it('reads a file once when two writes start at the same time', async () => {
    const { root, journal } = setup();
    writeFiles(root, { 'a.txt': 'a' });
    const file = path.join(root, 'a.txt');
    await Promise.all([journal.beforeWrite(file, 'one'), journal.beforeWrite(file, 'two')]);
    expect(journal.entries()).toEqual([expect.objectContaining({ path: 'a.txt', stepIds: ['one', 'two'] })]);
  });

  it('stores large originals as git blobs, or not at all without git', async () => {
    const storeLarge = vi.fn(async (_file: string) => 'abc123');
    const readLarge = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const limits = { fileBytes: 10, runBytes: 15 };
    const { root, journal } = setup({ storeLarge, readLarge, limits });
    writeFiles(root, { 'big.bin': 'x'.repeat(11), 'a.txt': 'aaaaaaaa', 'b.txt': 'bbbbbbbb' });
    await journal.beforeWrite(path.join(root, 'big.bin'), 's');
    await journal.beforeWrite(path.join(root, 'a.txt'), 's');
    // 8 + 8 bytes are over the run cap of 15: the second one goes to git too.
    await journal.beforeWrite(path.join(root, 'b.txt'), 's');
    expect(storeLarge.mock.calls.map(([file]) => path.basename(file as string))).toEqual([
      'big.bin',
      'b.txt',
    ]);
    expect([...((await journal.original('big.bin')) ?? [])]).toEqual([1, 2, 3]);
    expect(text(await journal.original('a.txt'))).toBe('aaaaaaaa');

    const plain = setup({ limits });
    writeFiles(plain.root, { 'big.bin': 'x'.repeat(11) });
    await plain.journal.beforeWrite(path.join(plain.root, 'big.bin'), 's');
    expect(plain.journal.entries()[0]).toMatchObject({ existed: true, originalStored: false });
    expect(await plain.journal.original('big.bin')).toBeUndefined();
  });

  it('does not store symbolic links', async (context) => {
    const { root, journal } = setup();
    writeFiles(root, { 'target.txt': 't' });
    try {
      fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'link.txt'));
    } catch {
      context.skip(); // Creating symbolic links needs extra rights on Windows.
    }
    await journal.beforeWrite(path.join(root, 'link.txt'), 's');
    expect(journal.entries()[0]).toMatchObject({ path: 'link.txt', existed: true, originalStored: false });
    expect(journal.isSymlink('link.txt')).toBe(true);
  });

  it('ignores files outside the root and never rejects', async () => {
    const { journal, log } = setup();
    await journal.beforeWrite(path.join(tempDir(), 'elsewhere.txt'), 's');
    expect(journal.entries()).toEqual([]);

    const broken = setup();
    // The journal folder can't be created: a file is in the way.
    fs.mkdirSync(path.dirname(broken.dir), { recursive: true });
    fs.writeFileSync(broken.dir, 'not a folder');
    writeFiles(broken.root, { 'a.txt': 'a' });
    await expect(broken.journal.beforeWrite(path.join(broken.root, 'a.txt'), 's')).resolves.toBeUndefined();
    expect(broken.journal.entries()[0]).toMatchObject({ path: 'a.txt', originalStored: false });
    expect(broken.log.lines.join('\n')).toMatch(/Could not keep the original of a\.txt/);
    expect(log.lines).toEqual([]);
  });

  it('records the hashes at the end of the run and survives a restart', async () => {
    const { root, dir, journal, log } = setup();
    writeFiles(root, { 'a.txt': 'before' });
    await journal.beforeWrite(path.join(root, 'a.txt'), 'edit');
    await journal.beforeWrite(path.join(root, 'gone.txt'), 'edit');
    fs.writeFileSync(path.join(root, 'a.txt'), 'after');
    await journal.seal();
    expect(journal.sealedHash('a.txt')).toBe(hashOf(new TextEncoder().encode('after')));
    expect(journal.sealedHash('gone.txt')).toBe('missing');

    const reopened = openEditJournal({ runId: 'run-1', root, dir, log });
    await reopened.ready;
    expect(reopened.entries().map((e) => e.path)).toEqual(['a.txt', 'gone.txt']);
    expect(text(await reopened.original('a.txt'))).toBe('before');
    expect(reopened.sealedHash('a.txt')).toBe(journal.sealedHash('a.txt'));
  });
});
