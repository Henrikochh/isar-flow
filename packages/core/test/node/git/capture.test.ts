import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureGitContext, GIT_DIFF_MAX_BYTES } from '../../../src/node/git';

const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
const hasGit = gitVersion.status === 0;
if (!hasGit) console.warn('Skipping the git capture tests: git is not on the PATH.');

const EMPTY = { branch: '', changedFiles: [], diff: '' };
const bytes = (text: string) => new TextEncoder().encode(text).length;

let base = '';
let count = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-11-03T10:00:00',
      GIT_COMMITTER_DATE: '2026-11-03T10:00:00',
    },
  });
}

function write(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A new repository on branch main with the files committed (none: an unborn branch). */
function repo(files: Record<string, string | Buffer> = {}): string {
  const root = join(base, `repo-${++count}`);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  if (Object.keys(files).length > 0) {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial');
  }
  return root;
}

// Each test creates a repository with several git calls; on a loaded Windows machine that takes seconds.
describe.skipIf(!hasGit)('captureGitContext', { timeout: 30_000 }, () => {
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'isarflow-git-'));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it('is empty outside a repository', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const outside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: plain,
      encoding: 'utf8',
    });
    if (outside.stdout.trim() === 'true') return; // the temp folder itself is inside a repository
    expect(await captureGitContext(plain)).toEqual(EMPTY);
  });

  it('is empty for a missing folder and without git', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    expect(await captureGitContext(join(base, 'missing-folder'))).toEqual(EMPTY);
    expect(await captureGitContext(root, { gitPath: join(base, 'no-git-here', 'git') })).toEqual(EMPTY);
  });

  it('reads a clean repository', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    expect(await captureGitContext(root)).toEqual({ branch: 'main', changedFiles: [], diff: '' });
  });

  it('lists modified, staged, deleted, renamed and untracked files with spaces and non-ASCII names', async () => {
    const root = repo({
      'src/app.ts': 'one\n',
      'old name.md': 'x\n',
      'gone.txt': 'bye\n',
      'keep.txt': 'k\n',
    });
    write(root, 'src/app.ts', 'one\ntwo\n');
    mkdirSync(join(root, 'docs'));
    git(root, 'mv', 'old name.md', 'docs/new näme.md');
    rmSync(join(root, 'gone.txt'));
    write(root, 'dir with space/ünïcode file.ts', 'u\n');
    write(root, 'staged.txt', 's\n');
    git(root, 'add', 'staged.txt');

    const context = await captureGitContext(root);

    expect(context.branch).toBe('main');
    expect(context.changedFiles).toEqual([
      'dir with space/ünïcode file.ts',
      'docs/new näme.md',
      'gone.txt',
      'src/app.ts',
      'staged.txt',
    ]);
    expect(context.diff).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(context.diff).toContain('+two');
    expect(context.diff).toContain('rename to docs/new näme.md');
    expect(context.diff).toContain('deleted file mode');
    expect(context.diff).toContain('b/staged.txt');
    expect(context.diff).not.toContain('ünïcode');
  });

  it('has no branch on a detached HEAD', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    git(root, 'checkout', '-q', '--detach');
    write(root, 'a.txt', 'b\n');
    const context = await captureGitContext(root);
    expect(context.branch).toBe('');
    expect(context.changedFiles).toEqual(['a.txt']);
    expect(context.diff).toContain('+b');
  });

  it('reads an unborn branch: staged changes against the empty tree plus unstaged ones', async () => {
    const root = repo();
    write(root, 'first.txt', 'staged line\n');
    git(root, 'add', 'first.txt');
    write(root, 'first.txt', 'staged line\nunstaged line\n');
    write(root, 'untracked.txt', 'u\n');

    const context = await captureGitContext(root);

    expect(context.branch).toBe('main');
    expect(context.changedFiles).toEqual(['first.txt', 'untracked.txt']);
    expect(context.diff).toContain('new file mode');
    expect(context.diff).toContain('+staged line');
    expect(context.diff).toContain('+unstaged line');
    expect(context.diff.indexOf('+staged line')).toBeLessThan(context.diff.indexOf('+unstaged line'));
  });

  it('is relative to a subfolder of the repository', async () => {
    const root = repo({ 'packages/app/src/a.ts': 'a\n', 'packages/other/b.ts': 'b\n', 'top.txt': 't\n' });
    write(root, 'packages/app/src/a.ts', 'a2\n');
    write(root, 'packages/other/b.ts', 'b2\n');
    write(root, 'top.txt', 't2\n');
    write(root, 'packages/app/new.txt', 'n\n');

    const context = await captureGitContext(join(root, 'packages', 'app'));

    expect(context.changedFiles).toEqual(['new.txt', 'src/a.ts']);
    expect(context.diff).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(context.diff).not.toContain('b.ts');
    expect(context.diff).not.toContain('top.txt');
  });

  it('cuts a 300 KB diff at 100 KB with git totals', async () => {
    const line = (i: number, tag: string) => `${tag} line ${String(i).padStart(5, '0')} ${'.'.repeat(48)}\n`;
    const before = Array.from({ length: 5000 }, (_, i) => line(i, 'old')).join('');
    const root = repo({ 'big.txt': before });
    write(root, 'big.txt', Array.from({ length: 5000 }, (_, i) => line(i, 'new')).join(''));

    const context = await captureGitContext(root);

    expect(bytes(context.diff)).toBeLessThanOrEqual(GIT_DIFF_MAX_BYTES);
    expect(bytes(context.diff)).toBeGreaterThan(GIT_DIFF_MAX_BYTES - 200);
    expect(context.diff.startsWith('diff --git a/big.txt b/big.txt')).toBe(true);
    expect(context.diff).toMatch(
      /\n… The diff was shortened to 100 KB \(1 file changed, 5000 insertions\(\+\), 5000 deletions\(-\)\)\.$/,
    );
    const lines = context.diff.split('\n');
    expect(lines.at(-2)).toMatch(/^[-+](old|new) line \d{5} \.{48}$/);
  });

  it('uses the given diff cap', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    write(root, 'a.txt', Array.from({ length: 500 }, (_, i) => `line ${i}\n`).join(''));
    const context = await captureGitContext(root, { maxDiffBytes: 1000 });
    expect(bytes(context.diff)).toBeLessThanOrEqual(1000);
    expect(context.diff).toMatch(
      /shortened to 1000 bytes \(1 file changed, 500 insertions\(\+\), 1 deletion\(-\)\)\.$/,
    );
  });

  it('cuts the diff of an unborn branch with both totals', async () => {
    const root = repo();
    write(root, 'a.txt', 'x\n'.repeat(2000));
    git(root, 'add', 'a.txt');
    write(root, 'a.txt', 'y\n'.repeat(2000));
    const context = await captureGitContext(root, { maxDiffBytes: 2000 });
    expect(bytes(context.diff)).toBeLessThanOrEqual(2000);
    expect(context.diff).toMatch(
      /\(staged: 1 file changed, 2000 insertions\(\+\); not staged: 1 file changed, 2000 insertions\(\+\), 2000 deletions\(-\)\)\.$/,
    );
  });

  it('shows binary files as git prints them', async () => {
    const root = repo({ 'img.bin': Buffer.from([0, 1, 2, 3, 0, 255]) });
    write(root, 'img.bin', Buffer.from([0, 9, 9, 9, 0, 255, 7]));
    const context = await captureGitContext(root);
    expect(context.changedFiles).toEqual(['img.bin']);
    expect(context.diff).toContain('Binary files a/img.bin and b/img.bin differ');
  });

  it('keeps at most 1,000 changed files', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    for (let i = 0; i < 1005; i++) write(root, `many/f${String(i).padStart(4, '0')}.txt`, '');
    const context = await captureGitContext(root);
    expect(context.changedFiles).toHaveLength(1000);
    expect(context.changedFiles[0]).toBe('many/f0000.txt');
    expect(context.changedFiles[999]).toBe('many/f0999.txt');
  });

  it('leaves the fields empty when git is too slow', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    write(root, 'a.txt', 'b\n');
    expect(await captureGitContext(root, { timeoutMs: 1 })).toEqual(EMPTY);
  });

  it('stops when the signal aborts', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    write(root, 'a.txt', 'b\n');
    const aborted = new AbortController();
    aborted.abort();
    expect(await captureGitContext(root, { signal: aborted.signal })).toEqual(EMPTY);

    const controller = new AbortController();
    const pending = captureGitContext(root, { signal: controller.signal });
    controller.abort();
    const context = await pending;
    expect(context.diff).toBe('');
  });

  it('ignores GIT_DIR of the environment', async () => {
    const root = repo({ 'a.txt': 'a\n' });
    write(root, 'a.txt', 'b\n');
    const other = repo({ 'z.txt': 'z\n' });
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
      expect((await captureGitContext(root)).changedFiles).toEqual(['a.txt']);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});
