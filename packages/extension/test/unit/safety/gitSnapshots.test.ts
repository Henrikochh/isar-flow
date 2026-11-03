import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitSnapshots, type SafetySnapshot } from '../../../src/safety/gitSnapshots';
import { gitIn, hasGit, initRepo, removeTempDirs, silentLog, tempDir, writeFiles } from './gitRepo';

const describeGit = hasGit ? describe : describe.skip;
const SHA = /^[0-9a-f]{40,64}$/;
const text = (bytes: Uint8Array | undefined) => (bytes ? Buffer.from(bytes).toString('utf8') : undefined);

function userState(repo: string) {
  return {
    index: fs.readFileSync(path.join(repo, '.git', 'index')).toString('base64'),
    head: gitIn(repo, 'rev-parse', 'HEAD').trim(),
    branch: gitIn(repo, 'symbolic-ref', 'HEAD').trim(),
    stash: gitIn(repo, 'stash', 'list'),
    status: gitIn(repo, 'status', '--porcelain', '--untracked-files=all'),
  };
}

function setup() {
  const log = silentLog();
  const snapshots = createGitSnapshots({ storageDir: tempDir('isar-storage-'), log });
  return { log, snapshots };
}

afterAll(removeTempDirs);

describeGit('git snapshots', { timeout: 60_000 }, () => {
  it("leave the user's index, HEAD, branch, stash and working tree as they are", async () => {
    const repo = initRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'keep.txt': 'keep\n' });
    writeFiles(repo, { 'keep.txt': 'stashed\n' });
    gitIn(repo, 'stash', '-q');
    writeFiles(repo, { 'a.txt': 'a staged\n' });
    gitIn(repo, 'add', 'a.txt');
    writeFiles(repo, { 'b.txt': 'b unstaged\n', 'c.txt': 'untracked\n' });
    const { snapshots } = setup();

    const atStart = userState(repo);
    const before = await snapshots.begin('run-1', repo);
    expect(userState(repo)).toEqual(atStart);
    expect(before).toMatchObject({
      runId: 'run-1',
      root: repo,
      coverage: 'git',
      before: expect.stringMatching(SHA),
    });
    expect(gitIn(repo, 'rev-parse', 'refs/isarflow/runs/run-1/before').trim()).toBe(before.before);
    expect(gitIn(repo, 'log', '-1', '--format=%an <%ae> %s', before.before as string).trim()).toBe(
      'Isar Flow <isarflow@localhost> Isar Flow run run-1 (before)',
    );

    writeFiles(repo, { 'b.txt': 'b changed by the run\nsecond line\n', 'd.txt': 'new\n' });
    fs.rmSync(path.join(repo, 'c.txt'));
    const atEnd = userState(repo);
    const { snapshot, changes } = await snapshots.finish(before);
    expect(userState(repo)).toEqual(atEnd);
    expect(snapshot.after).toMatch(SHA);
    expect(gitIn(repo, 'rev-parse', 'refs/isarflow/runs/run-1/after').trim()).toBe(snapshot.after);
    expect(changes).toEqual([
      { path: 'b.txt', status: 'modified', additions: 2, deletions: 1 },
      { path: 'c.txt', status: 'deleted', additions: 0, deletions: 1 },
      { path: 'd.txt', status: 'added', additions: 1, deletions: 0 },
    ]);
    // The snapshot holds the working tree, staged changes included.
    expect(text(await snapshots.read(snapshot, 'before', 'a.txt'))).toBe('a staged\n');
    expect(text(await snapshots.read(snapshot, 'before', 'b.txt'))).toBe('b unstaged\n');
    expect(text(await snapshots.read(snapshot, 'after', 'b.txt'))).toBe(
      'b changed by the run\nsecond line\n',
    );
    expect(await snapshots.read(snapshot, 'before', 'd.txt')).toBeUndefined();
    expect(await snapshots.read(snapshot, 'after', 'c.txt')).toBeUndefined();
  });

  it('reports binary files, ignored files are left out', async () => {
    const repo = initRepo({ '.gitignore': 'build/\n', 'img.bin': new Uint8Array([0, 1, 2, 3]) });
    const { snapshots } = setup();
    const before = await snapshots.begin('run-bin', repo);
    writeFiles(repo, { 'img.bin': new Uint8Array([0, 9, 9, 9, 9]), 'build/out.js': 'x' });
    const { changes, snapshot } = await snapshots.finish(before);
    expect(changes).toEqual([{ path: 'img.bin', status: 'modified', binary: true }]);
    expect([...((await snapshots.read(snapshot, 'before', 'img.bin')) ?? [])]).toEqual([0, 1, 2, 3]);
  });

  it('covers only the folder when it is inside a larger repository, with paths relative to it', async () => {
    const repo = initRepo({ 'outside.txt': 'o\n', 'app/src/main.ts': 'one\n' });
    const folder = path.join(repo, 'app');
    const { snapshots } = setup();
    const before = (await snapshots.begin('run-sub', folder)) as SafetySnapshot;
    expect(before).toMatchObject({ root: folder, coverage: 'git', prefix: 'app/' });
    writeFiles(repo, { 'outside.txt': 'changed\n', 'app/src/main.ts': 'two\n', 'app/new.md': '# hi\n' });
    const { changes, snapshot } = await snapshots.finish(before);
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ['new.md', 'added'],
      ['src/main.ts', 'modified'],
    ]);
    expect(text(await snapshots.read(snapshot, 'before', 'src/main.ts'))).toBe('one\n');
  });

  it('works in a repository without commits', async () => {
    const repo = initRepo();
    writeFiles(repo, { 'first.txt': 'hello\n' });
    const { snapshots } = setup();
    const before = await snapshots.begin('run-empty', repo);
    expect(before.coverage).toBe('git');
    writeFiles(repo, { 'first.txt': 'hello again\n' });
    const { changes } = await snapshots.finish(before);
    expect(changes).toEqual([{ path: 'first.txt', status: 'modified', additions: 1, deletions: 1 }]);
    expect(fs.existsSync(path.join(repo, '.git', 'index'))).toBe(false);
  });

  it('reads files with the line endings of the working tree', async () => {
    const repo = initRepo({ 'win.txt': 'one\r\ntwo\r\n' }, 'true');
    const { snapshots } = setup();
    const before = await snapshots.begin('run-crlf', repo);
    writeFiles(repo, { 'win.txt': 'one\r\nthree\r\n' });
    const { snapshot, changes } = await snapshots.finish(before);
    expect(changes).toEqual([{ path: 'win.txt', status: 'modified', additions: 1, deletions: 1 }]);
    expect(text(await snapshots.read(snapshot, 'before', 'win.txt'))).toBe('one\r\ntwo\r\n');
  });

  it('snapshots files that core.safecrlf would refuse to add', async () => {
    const repo = initRepo({ 'unix.txt': 'one\ntwo\n' }, 'true');
    gitIn(repo, 'config', 'core.safecrlf', 'true');
    writeFiles(repo, { 'mixed.txt': 'a\r\nb\n' });
    const { snapshots, log } = setup();
    const before = await snapshots.begin('run-safecrlf', repo);
    expect(log.lines).toEqual([]);
    expect(before.coverage).toBe('git');
    writeFiles(repo, { 'unix.txt': 'one\nthree\n' });
    const { changes } = await snapshots.finish(before);
    expect(changes.map((c) => c.path)).toEqual(['unix.txt']);
  });

  it('marks symbolic links and submodules as special', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const inner = initRepo({ 'x.txt': 'x\n' });
    const { snapshots } = setup();
    const before = await snapshots.begin('run-special', repo);
    // An embedded repository is recorded as a gitlink (submodule pointer).
    fs.cpSync(inner, path.join(repo, 'inner'), { recursive: true });
    const { changes } = await snapshots.finish(before);
    expect(changes).toEqual([
      expect.objectContaining({ path: 'inner', status: 'added', special: 'submodule' }),
    ]);
  });

  it('falls back to journal coverage outside git repositories and logs it once', async () => {
    const folder = tempDir('isar-plain-');
    const { snapshots, log } = setup();
    const first = await snapshots.begin('run-a', folder);
    const second = await snapshots.begin('run-b', folder);
    expect(first).toEqual({ runId: 'run-a', root: folder, coverage: 'journal' });
    expect(second.coverage).toBe('journal');
    expect(log.lines.filter((l) => l.includes('not a git repository'))).toHaveLength(1);
    expect(await snapshots.finish(first)).toEqual({ snapshot: first, changes: [] });
    expect(await snapshots.read(first, 'before', 'x.txt')).toBeUndefined();
    await expect(snapshots.createWorktree(first, path.join(folder, 'wt'))).rejects.toThrow(
      `Isolation "worktree" needs a git repository. Run git init in ${folder}, or set isolation to workspace.`,
    );
  });

  it('falls back to journal coverage when git cannot be started', async () => {
    const log = silentLog();
    const snapshots = createGitSnapshots({ storageDir: tempDir(), log, gitPath: 'git-does-not-exist-here' });
    const repo = initRepo({ 'a.txt': 'a\n' });
    expect((await snapshots.begin('r1', repo)).coverage).toBe('journal');
    expect((await snapshots.begin('r2', repo)).coverage).toBe('journal');
    expect(log.lines.filter((l) => l.includes('git'))).toHaveLength(1);
  });

  it('falls back to journal coverage when the snapshot times out', async () => {
    const log = silentLog();
    const snapshots = createGitSnapshots({ storageDir: tempDir(), log, timeoutMs: 1 });
    const repo = initRepo({ 'a.txt': 'a\n' });
    const snapshot = await snapshots.begin('slow', repo);
    expect(snapshot.coverage).toBe('journal');
    expect(log.lines.join('\n')).toMatch(/Could not snapshot/);
  });

  it('creates, lists and removes worktrees at the before snapshot', async () => {
    const repo = initRepo({ 'app/a.txt': 'committed\n' });
    writeFiles(repo, { 'app/a.txt': 'uncommitted\n' });
    const { snapshots } = setup();
    const folder = path.join(repo, 'app');
    const before = (await snapshots.begin('run-wt', folder)) as SafetySnapshot;
    const worktree = path.join(tempDir('isar-wt-'), 'run-wt');
    await snapshots.createWorktree(before, worktree);
    expect(fs.readFileSync(path.join(worktree, 'app', 'a.txt'), 'utf8')).toBe('uncommitted\n');
    expect(gitIn(repo, 'status', '--porcelain')).toBe(' M app/a.txt\n');

    // The run works in the worktree; its after snapshot covers the same folder there.
    writeFiles(worktree, { 'app/a.txt': 'from the run\n', 'app/b.txt': 'added\n' });
    const inWorktree = { ...before, root: path.join(worktree, 'app') };
    const { changes, snapshot } = await snapshots.finish(inWorktree);
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ['a.txt', 'modified'],
      ['b.txt', 'added'],
    ]);
    expect(text(await snapshots.read(snapshot, 'after', 'b.txt'))).toBe('added\n');

    await snapshots.removeWorktree(folder, worktree);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain('run-wt');
  });

  it('removes a worktree folder that git no longer knows', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const { snapshots } = setup();
    const before = await snapshots.begin('run-gone', repo);
    const worktree = path.join(tempDir('isar-wt-'), 'run-gone');
    await snapshots.createWorktree(before, worktree);
    fs.rmSync(path.join(worktree, '.git'));
    await snapshots.removeWorktree(repo, worktree);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain('run-gone');
  });

  it('prunes the refs of removed runs only', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const { snapshots } = setup();
    for (const runId of ['old-1', 'old-2', 'kept']) {
      await snapshots.finish(await snapshots.begin(runId, repo));
    }
    await snapshots.prune(repo, ['old-1', 'old-2', 'never-existed']);
    const refs = gitIn(repo, 'for-each-ref', '--format=%(refname)', 'refs/isarflow/').trim().split('\n');
    expect(refs).toEqual(['refs/isarflow/runs/kept/after', 'refs/isarflow/runs/kept/before']);
    await expect(snapshots.prune(tempDir('isar-plain-'), ['x'])).resolves.toBeUndefined();
  });
});
