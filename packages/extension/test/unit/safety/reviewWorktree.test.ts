import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitSnapshots } from '../../../src/safety/gitSnapshots';
import { createRunSafety } from '../../../src/safety/runSafety';
import { gitIn, hasGit, initRepo, removeTempDirs, silentLog, tempDir, writeFiles } from './gitRepo';
import { fakeHistory, fakeReviewUi, nodeFiles, safetyHarness, WORKFLOW_URI } from './harness';

const describeGit = hasGit ? describe : describe.skip;
const read = (file: string) => fs.readFileSync(file, 'utf8');

afterAll(removeTempDirs);

describeGit('worktree runs', { timeout: 60_000 }, () => {
  /** A repository with the workflow's folder `app/` and an uncommitted change in it. */
  async function worktreeRun() {
    const repo = initRepo({ 'app/a.txt': 'a\n', 'app/old.txt': 'old\n', 'other/x.txt': 'x\n' });
    writeFiles(repo, { 'app/a.txt': 'uncommitted\n' });
    const folder = path.join(repo, 'app');
    const h = safetyHarness();
    let runRoot = '';
    const { count } = await h.run(
      folder,
      'wt-1',
      async ({ root, journal }) => {
        runRoot = root;
        expect(read(path.join(root, 'a.txt'))).toBe('uncommitted\n');
        await journal.beforeWrite(path.join(root, 'a.txt'), 'implement');
        writeFiles(root, { 'a.txt': 'from the run\n', 'new.txt': 'new\n' });
        fs.rmSync(path.join(root, 'old.txt'));
      },
      'worktree',
    );
    return { repo, folder, h, count, runRoot };
  }

  it('work in a worktree at the snapshot and leave the workspace alone', async () => {
    const { folder, h, count, runRoot } = await worktreeRun();
    expect(runRoot).toBe(path.join(h.storageDir, 'worktrees', 'wt-1', 'app'));
    expect(count).toBe(3);
    expect(read(path.join(folder, 'a.txt'))).toBe('uncommitted\n');
    expect(fs.existsSync(path.join(folder, 'new.txt'))).toBe(false);
    expect(await h.safety.reviews.get('wt-1')).toEqual({
      runId: 'wt-1',
      coverage: 'git',
      isolation: 'worktree',
      worktreeAvailable: true,
      files: [
        {
          path: 'a.txt',
          status: 'modified',
          additions: 1,
          deletions: 1,
          stepIds: ['implement'],
          decision: 'pending',
          revertible: true,
        },
        {
          path: 'new.txt',
          status: 'added',
          additions: 1,
          deletions: 0,
          stepIds: [],
          decision: 'pending',
          revertible: true,
        },
        {
          path: 'old.txt',
          status: 'deleted',
          additions: 0,
          deletions: 1,
          stepIds: [],
          decision: 'pending',
          revertible: true,
        },
      ],
    });
  });

  it('apply kept files to the workspace, drop reverted ones and remove the worktree at the end', async () => {
    const { repo, folder, h } = await worktreeRun();
    await h.safety.reviews.decide('wt-1', 'kept', ['a.txt']);
    await h.safety.reviews.decide('wt-1', 'kept', ['old.txt']);
    expect(read(path.join(folder, 'a.txt'))).toBe('from the run\n');
    expect(fs.existsSync(path.join(folder, 'old.txt'))).toBe(false);
    expect((await h.safety.reviews.get('wt-1'))?.worktreeAvailable).toBe(true);

    await h.safety.reviews.decide('wt-1', 'reverted');
    expect(fs.existsSync(path.join(folder, 'new.txt'))).toBe(false);
    const review = await h.safety.reviews.get('wt-1');
    expect(review?.files.map((f) => [f.path, f.decision])).toEqual([
      ['a.txt', 'kept'],
      ['new.txt', 'reverted'],
      ['old.txt', 'kept'],
    ]);
    expect(review?.worktreeAvailable).toBe(false);
    expect(fs.existsSync(path.join(h.storageDir, 'worktrees', 'wt-1'))).toBe(false);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain('wt-1');
    expect(h.history.records[0].review).toEqual({ total: 3, kept: 2, reverted: 1, pending: 0 });
  });

  it('ask before replacing workspace files that changed during the run', async () => {
    const { folder, h } = await worktreeRun();
    writeFiles(folder, { 'a.txt': 'edited in the workspace\n', 'new.txt': 'also here\n' });

    await h.safety.reviews.decide('wt-1', 'kept', ['a.txt']);
    expect(h.ui.asked).toEqual([
      {
        message: "a.txt changed in your workspace during the run. Replace it with the run's version?",
        buttons: ['Replace'],
      },
    ]);
    expect(read(path.join(folder, 'a.txt'))).toBe('edited in the workspace\n');

    h.ui.answers.push('Skip changed files');
    await h.safety.reviews.decide('wt-1', 'kept');
    expect(h.ui.asked[1]).toEqual({
      message: '2 files changed in your workspace during the run: a.txt, new.txt.',
      detail: 'Replacing them loses the changes you made in your workspace.',
      buttons: ['Replace all', 'Skip changed files'],
    });
    expect(fs.existsSync(path.join(folder, 'old.txt'))).toBe(false);
    expect(read(path.join(folder, 'new.txt'))).toBe('also here\n');

    h.ui.answers.push('Replace all');
    await h.safety.reviews.decide('wt-1', 'kept');
    expect(read(path.join(folder, 'a.txt'))).toBe('from the run\n');
    expect(read(path.join(folder, 'new.txt'))).toBe('new\n');
    expect((await h.safety.reviews.get('wt-1'))?.worktreeAvailable).toBe(false);
  });

  it('diff against the worktree file while it exists', async () => {
    const { h } = await worktreeRun();
    await h.safety.reviews.openDiff('wt-1', 'a.txt');
    const [[, left, right]] = (
      h.ui.ui.executeCommand as unknown as {
        mock: { calls: [string, { path: string }, { fsPath: string }][] };
      }
    ).mock.calls;
    expect(left.path).toBe('/wt-1/before/a.txt');
    expect(path.resolve(right.fsPath)).toBe(path.join(h.storageDir, 'worktrees', 'wt-1', 'app', 'a.txt'));
  });

  it('need git', async () => {
    const folder = tempDir('isar-plain-');
    const h = safetyHarness();
    expect(await h.safety.canIsolate(folder)).toBe(false);
    await expect(
      h.safety.begin({ runId: 'nogit', workflowUri: WORKFLOW_URI, folder, isolation: 'worktree' }),
    ).rejects.toThrow(
      `Isolation "worktree" needs a git repository. Run git init in ${folder}, or set isolation to workspace.`,
    );
    expect(await h.safety.canIsolate(initRepo())).toBe(true);
  });

  it('explain a snapshot that failed in a repository', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const storageDir = tempDir('isar-storage-');
    const log = silentLog();
    const safety = createRunSafety({
      storageDir,
      log,
      history: fakeHistory().history,
      snapshots: createGitSnapshots({ storageDir, log, timeoutMs: 1 }),
      files: nodeFiles().files,
      ui: fakeReviewUi().ui,
    });
    await expect(
      safety.begin({ runId: 'slow', workflowUri: WORKFLOW_URI, folder: repo, isolation: 'worktree' }),
    ).rejects.toThrow(
      `Could not take the snapshot of ${repo} that the worktree starts from. See the Isar Flow log for details.`,
    );
  });

  it('leave nothing behind when discarded', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const h = safetyHarness();
    const session = await h.safety.begin({
      runId: 'setup-failed',
      workflowUri: WORKFLOW_URI,
      folder: repo,
      isolation: 'worktree',
    });
    expect(fs.existsSync(session.root)).toBe(true);
    await session.discard();
    expect(fs.existsSync(session.root)).toBe(false);
    expect(gitIn(repo, 'for-each-ref', 'refs/isarflow/')).toBe('');
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain('setup-failed');
    expect(fs.existsSync(path.join(h.storageDir, 'reviews', 'setup-failed'))).toBe(false);
  });

  it('are cleaned up at startup when no saved run needs them', async () => {
    const { repo, h } = await worktreeRun();
    // A run still waiting for decisions keeps its worktree; an unknown worktree folder and a review of a run
    // that is not in the history (VS Code closed before it was saved) go.
    const previousSession = createRunSafety({
      storageDir: h.storageDir,
      log: silentLog(),
      history: h.history.history,
      files: nodeFiles().files,
      ui: fakeReviewUi().ui,
    });
    const orphan = await previousSession.begin({
      runId: 'orphan',
      workflowUri: WORKFLOW_URI,
      folder: repo,
      isolation: 'worktree',
    });
    await orphan.finish({ skipSnapshot: true });
    fs.mkdirSync(path.join(h.storageDir, 'worktrees', 'stray'), { recursive: true });

    await h.safety.cleanup();
    expect(fs.existsSync(path.join(h.storageDir, 'worktrees', 'wt-1'))).toBe(true);
    expect(fs.existsSync(path.join(h.storageDir, 'worktrees', 'orphan'))).toBe(false);
    expect(fs.existsSync(path.join(h.storageDir, 'worktrees', 'stray'))).toBe(false);
    expect(fs.existsSync(path.join(h.storageDir, 'reviews', 'orphan'))).toBe(false);
    expect(gitIn(repo, 'for-each-ref', '--format=%(refname)', 'refs/isarflow/')).not.toContain('orphan');

    await h.safety.reviews.decide('wt-1', 'kept', ['a.txt']);
    // Decided files no longer need the worktree once nothing is pending; a worktree of a decided run goes too.
    const state = await h.safety.reviews.state('wt-1');
    for (const file of state?.files ?? []) file.decision = 'kept';
    await h.safety.cleanup();
    expect(fs.existsSync(path.join(h.storageDir, 'worktrees', 'wt-1'))).toBe(false);
    expect((await h.safety.reviews.get('wt-1'))?.worktreeAvailable).toBe(false);
  });

  it('are not cleaned up while a run of this session is starting or not saved to the history yet', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const h = safetyHarness();
    const session = await h.safety.begin({
      runId: 'fresh',
      workflowUri: WORKFLOW_URI,
      folder: repo,
      isolation: 'worktree',
    });
    writeFiles(session.root, { 'a.txt': 'from the run\n' });
    await h.safety.cleanup();
    expect(fs.existsSync(session.root)).toBe(true);

    // Between the end of the run and its history entry.
    expect(await session.finish()).toBe(1);
    await h.safety.cleanup();
    expect(read(path.join(session.root, 'a.txt'))).toBe('from the run\n');
    h.history.add('fresh');
    await session.publish();
    expect((await h.safety.reviews.get('fresh'))?.files).toHaveLength(1);
    await h.safety.reviews.decide('fresh', 'kept');
    expect(read(path.join(repo, 'a.txt'))).toBe('from the run\n');
  });

  it('are removed with their run from the history', async () => {
    const { h } = await worktreeRun();
    h.history.removed.fire({ workflowUri: WORKFLOW_URI, runIds: ['wt-1'] });
    await h.safety.whenIdle();
    expect(fs.existsSync(path.join(h.storageDir, 'worktrees', 'wt-1'))).toBe(false);
    expect(await h.safety.reviews.get('wt-1')).toBeUndefined();
  });
});
