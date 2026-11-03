import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitIn, hasGit, initRepo, removeTempDirs, tempDir, writeFiles } from './gitRepo';
import { safetyHarness, WORKFLOW_URI } from './harness';

const describeGit = hasGit ? describe : describe.skip;
const read = (file: string) => fs.readFileSync(file, 'utf8');

afterAll(removeTempDirs);

describeGit('review of a workspace run in a git repository', { timeout: 60_000 }, () => {
  async function changedRun() {
    const repo = initRepo({
      'src/app.ts': 'one\r\ntwo\r\n',
      'docs/old.md': '# Old\n',
      'logo.png': new Uint8Array([0, 1, 2]),
      '.gitignore': 'dist/\n',
    });
    const h = safetyHarness();
    const { count } = await h.run(repo, 'run-1', async ({ journal, root }) => {
      await journal.beforeWrite(path.join(root, 'src', 'app.ts'), 'implement');
      writeFiles(root, { 'src/app.ts': 'one\r\nTWO\r\nthree\r\n' });
      await journal.beforeWrite(path.join(root, 'dist', 'bundle.js'), 'build');
      writeFiles(root, { 'dist/bundle.js': 'ignored but journaled\n', 'notes/new.txt': 'by a command\n' });
      writeFiles(root, { 'logo.png': new Uint8Array([0, 9, 9]) });
      fs.rmSync(path.join(root, 'docs', 'old.md'));
    });
    return { repo, h, count };
  }

  it('lists added, modified, deleted, binary and journal-only files with the blocks that wrote them', async () => {
    const { repo, h, count } = await changedRun();
    expect(count).toBe(5);
    const review = await h.safety.reviews.get('run-1');
    expect(review).toEqual({
      runId: 'run-1',
      coverage: 'git',
      isolation: 'workspace',
      files: [
        {
          path: 'dist/bundle.js',
          status: 'added',
          additions: 1,
          deletions: 0,
          stepIds: ['build'],
          decision: 'pending',
          revertible: true,
        },
        {
          path: 'docs/old.md',
          status: 'deleted',
          additions: 0,
          deletions: 1,
          stepIds: [],
          decision: 'pending',
          revertible: true,
        },
        {
          path: 'logo.png',
          status: 'modified',
          binary: true,
          stepIds: [],
          decision: 'pending',
          revertible: true,
        },
        {
          path: 'notes/new.txt',
          status: 'added',
          additions: 1,
          deletions: 0,
          stepIds: [],
          decision: 'pending',
          revertible: true,
        },
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
          stepIds: ['implement'],
          decision: 'pending',
          revertible: true,
        },
      ],
    });
    expect(h.history.setReview).toHaveBeenCalledWith('run-1', { total: 5, kept: 0, reverted: 0, pending: 5 });
    expect(h.changes).toEqual([{ runId: 'run-1', workflowUri: WORKFLOW_URI }]);
    expect(fs.existsSync(path.join(h.storageDir, 'reviews', 'run-1', 'review.json'))).toBe(true);
    expect(gitIn(repo, 'for-each-ref', '--format=%(refname)', 'refs/isarflow/')).toContain('run-1/after');
  });

  it('reverts every status to the state before the run, line endings included', async () => {
    const { repo, h } = await changedRun();
    await h.safety.reviews.decide('run-1', 'reverted');
    expect(h.ui.asked).toEqual([]);
    expect(read(path.join(repo, 'src', 'app.ts'))).toBe('one\r\ntwo\r\n');
    expect(read(path.join(repo, 'docs', 'old.md'))).toBe('# Old\n');
    expect([...fs.readFileSync(path.join(repo, 'logo.png'))]).toEqual([0, 1, 2]);
    expect(fs.existsSync(path.join(repo, 'notes', 'new.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'dist', 'bundle.js'))).toBe(false);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');

    const review = await h.safety.reviews.get('run-1');
    expect(review?.files.map((f) => f.decision)).toEqual(Array(5).fill('reverted'));
    expect(h.history.setReview).toHaveBeenLastCalledWith('run-1', {
      total: 5,
      kept: 0,
      reverted: 5,
      pending: 0,
    });
  });

  it('reverts to the state before the run when a command changed the file before an agent did', async () => {
    const repo = initRepo({ 'config.json': '{ "a": 1 }\r\n' });
    const h = safetyHarness();
    await h.run(repo, 'run-1', async ({ journal, root }) => {
      writeFiles(root, { 'config.json': '{ "a": 2 }\r\n' });
      await journal.beforeWrite(path.join(root, 'config.json'), 'edit');
      writeFiles(root, { 'config.json': '{ "a": 3 }\r\n' });
    });
    const provider = h.safety.reviews.contentProvider;
    const before = await provider.provideTextDocumentContent(
      { scheme: 'isarflow-snapshot', path: '/run-1/before/config.json' } as never,
      undefined as never,
    );
    expect(before).toBe('{ "a": 1 }\r\n');

    await h.safety.reviews.decide('run-1', 'reverted');
    expect(read(path.join(repo, 'config.json'))).toBe('{ "a": 1 }\r\n');
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
  });

  it('reverts to the unsaved text an editor had, which the agent write saved', async () => {
    const repo = initRepo({ 'notes.md': '# Notes\n' });
    const h = safetyHarness();
    await h.run(repo, 'run-1', async ({ journal, root }) => {
      await journal.beforeWrite(path.join(root, 'notes.md'), 'edit', '# Notes\ntyped, not saved\n');
      writeFiles(root, { 'notes.md': '# Notes\ntyped, not saved\nby the agent\n' });
    });
    await h.safety.reviews.decide('run-1', 'reverted');
    expect(read(path.join(repo, 'notes.md'))).toBe('# Notes\ntyped, not saved\n');
  });

  it("can't revert a file whose unsaved editor text was too large to keep", async () => {
    const repo = initRepo({ 'big.txt': 'small on disk\n' });
    const h = safetyHarness();
    await h.run(repo, 'run-1', async ({ journal, root }) => {
      await journal.beforeWrite(path.join(root, 'big.txt'), 'edit', 'x'.repeat(2 * 1024 * 1024 + 1));
      writeFiles(root, { 'big.txt': 'saved by the agent\n' });
    });
    expect((await h.safety.reviews.get('run-1'))?.files[0]).toMatchObject({
      path: 'big.txt',
      revertible: false,
    });
    await h.safety.reviews.decide('run-1', 'reverted');
    expect(read(path.join(repo, 'big.txt'))).toBe('saved by the agent\n');
  });

  it('lists a file once when an agent wrote it with other letter case than git knows', async (context) => {
    const repo = initRepo({ 'src/App.ts': 'one\n' });
    if (!fs.existsSync(path.join(repo, 'SRC', 'app.TS'))) context.skip(); // A case-sensitive file system.
    const h = safetyHarness();
    await h.run(repo, 'run-1', async ({ journal, root }) => {
      await journal.beforeWrite(path.join(root, 'SRC', 'app.TS'), 'edit', 'one\ntyped\n');
      writeFiles(root, { 'src/App.ts': 'one\ntyped\nagent\n' });
    });
    const review = await h.safety.reviews.get('run-1');
    expect(review?.files.map((f) => [f.path, f.stepIds])).toEqual([['src/App.ts', ['edit']]]);
    await h.safety.reviews.decide('run-1', 'reverted');
    expect(read(path.join(repo, 'src', 'App.ts'))).toBe('one\ntyped\n');
  });

  it('keeps by marking only, and decisions are final', async () => {
    const { repo, h } = await changedRun();
    await h.safety.reviews.decide('run-1', 'kept', ['src/app.ts']);
    await h.safety.reviews.decide('run-1', 'reverted', ['src/app.ts']);
    expect(read(path.join(repo, 'src', 'app.ts'))).toBe('one\r\nTWO\r\nthree\r\n');
    const review = await h.safety.reviews.get('run-1');
    expect(review?.files.find((f) => f.path === 'src/app.ts')?.decision).toBe('kept');
    expect(h.history.records[0].review).toEqual({ total: 5, kept: 1, reverted: 0, pending: 4 });
  });

  it('asks before reverting a file that changed after the run', async () => {
    const { repo, h } = await changedRun();
    const app = path.join(repo, 'src', 'app.ts');
    writeFiles(repo, { 'src/app.ts': 'edited later\n' });

    await h.safety.reviews.decide('run-1', 'reverted', ['src/app.ts']);
    expect(h.ui.asked).toEqual([
      {
        message: 'src/app.ts changed after the run. Revert it anyway? Your newer changes to it are lost.',
        buttons: ['Revert anyway'],
      },
    ]);
    expect(read(app)).toBe('edited later\n');
    expect((await h.safety.reviews.get('run-1'))?.files.find((f) => f.path === 'src/app.ts')?.decision).toBe(
      'pending',
    );

    h.ui.answers.push('Revert anyway');
    await h.safety.reviews.decide('run-1', 'reverted', ['src/app.ts']);
    expect(read(app)).toBe('one\r\ntwo\r\n');
  });

  it('counts unsaved edits in an open editor as a change after the run', async () => {
    const { repo, h } = await changedRun();
    h.files.dirty.set(path.join(repo, 'src', 'app.ts'), 'typed but not saved');
    await h.safety.reviews.decide('run-1', 'reverted', ['src/app.ts']);
    expect(h.ui.asked).toHaveLength(1);
  });

  it('asks once for all files that changed after the run when reverting all', async () => {
    const { repo, h } = await changedRun();
    writeFiles(repo, { 'src/app.ts': 'later\n', 'notes/new.txt': 'later\n' });
    fs.rmSync(path.join(repo, 'dist', 'bundle.js'));

    await h.safety.reviews.decide('run-1', 'reverted');
    expect(h.ui.asked).toEqual([
      {
        message: '3 files changed after the run: dist/bundle.js, notes/new.txt, src/app.ts.',
        detail: 'Reverting them loses your newer changes to them.',
        buttons: ['Revert all anyway', 'Skip changed files'],
      },
    ]);
    // Cancel: nothing changes.
    expect(read(path.join(repo, 'src', 'app.ts'))).toBe('later\n');
    expect(fs.existsSync(path.join(repo, 'docs', 'old.md'))).toBe(false);

    h.ui.answers.push('Skip changed files');
    await h.safety.reviews.decide('run-1', 'reverted');
    expect(read(path.join(repo, 'src', 'app.ts'))).toBe('later\n');
    expect(read(path.join(repo, 'docs', 'old.md'))).toBe('# Old\n');
    const decisions = Object.fromEntries(
      ((await h.safety.reviews.get('run-1'))?.files ?? []).map((f) => [f.path, f.decision]),
    );
    expect(decisions).toEqual({
      'dist/bundle.js': 'pending',
      'docs/old.md': 'reverted',
      'logo.png': 'reverted',
      'notes/new.txt': 'pending',
      'src/app.ts': 'pending',
    });

    h.ui.answers.push('Revert all anyway');
    await h.safety.reviews.decide('run-1', 'reverted');
    expect(read(path.join(repo, 'src', 'app.ts'))).toBe('one\r\ntwo\r\n');
    expect(fs.existsSync(path.join(repo, 'notes', 'new.txt'))).toBe(false);
  });

  it('shows the file as busy while reverting and keeps a failed file pending with its error', async () => {
    const { repo, h } = await changedRun();
    h.files.failWrites.add(path.join(repo, 'src', 'app.ts'));
    const busy: (boolean | undefined)[] = [];
    h.safety.reviews.onDidChange(async () => busy.push((await h.safety.reviews.get('run-1'))?.busy));
    await h.safety.reviews.decide('run-1', 'reverted', ['src/app.ts']);
    const file = (await h.safety.reviews.get('run-1'))?.files.find((f) => f.path === 'src/app.ts');
    expect(file).toMatchObject({
      decision: 'pending',
      error: 'Could not revert src/app.ts: The disk is full.',
    });
    expect(busy).toContain(true);
    expect((await h.safety.reviews.get('run-1'))?.busy).toBeUndefined();

    h.files.failWrites.clear();
    await h.safety.reviews.decide('run-1', 'reverted', ['src/app.ts']);
    const retried = (await h.safety.reviews.get('run-1'))?.files.find((f) => f.path === 'src/app.ts');
    expect(retried).toMatchObject({ decision: 'reverted' });
    expect(retried?.error).toBeUndefined();
  });

  it('opens a diff of the snapshot before the run and the file now', async () => {
    const { repo, h } = await changedRun();
    const { reviews } = h.safety;
    await reviews.openDiff('run-1', 'src/app.ts');
    await reviews.openDiff('run-1', 'notes/new.txt');
    await reviews.openDiff('run-1', 'docs/old.md');
    const calls = (h.ui.ui.executeCommand as ReturnType<typeof import('vitest').vi.fn>).mock.calls as [
      string,
      { scheme: string; path: string; fsPath: string },
      { scheme: string; path: string; fsPath: string },
      string,
    ][];
    expect(
      calls.map(([command, left, right, title]) => [
        command,
        `${left.scheme}:${left.path}`,
        right.scheme,
        title,
      ]),
    ).toEqual([
      ['vscode.diff', 'isarflow-snapshot:/run-1/before/src/app.ts', 'file', 'app.ts: before the run and now'],
      [
        'vscode.diff',
        'isarflow-snapshot:/run-1/empty/notes/new.txt',
        'file',
        'new.txt: before the run and now',
      ],
      [
        'vscode.diff',
        'isarflow-snapshot:/run-1/before/docs/old.md',
        'isarflow-snapshot',
        'old.md: before the run and now',
      ],
    ]);
    expect(path.resolve(calls[0][2].fsPath)).toBe(path.join(repo, 'src', 'app.ts'));
    expect(calls[2][2].path).toBe('/run-1/after/docs/old.md');

    const provider = reviews.contentProvider;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    const content = async (uri: { scheme: string; path: string }) =>
      provider.provideTextDocumentContent(uri as never, token as never);
    expect(await content(calls[0][1])).toBe('one\r\ntwo\r\n');
    expect(await content(calls[1][1])).toBe('');
    expect(await content(calls[2][2])).toBe('');
    expect(await content({ scheme: 'isarflow-snapshot', path: '/run-1/after/src/app.ts' })).toBe(
      'one\r\nTWO\r\nthree\r\n',
    );
    expect(await content({ scheme: 'isarflow-snapshot', path: '/../../etc/passwd' })).toBe('');
  });

  it("says that binary files can't be compared and offers to open them", async () => {
    const { repo, h } = await changedRun();
    h.ui.answerInfo('Open file');
    await h.safety.reviews.openDiff('run-1', 'logo.png');
    expect(h.ui.infos).toEqual([{ message: "Binary files can't be compared.", buttons: ['Open file'] }]);
    const [command, uri] = (h.ui.ui.executeCommand as ReturnType<typeof import('vitest').vi.fn>).mock
      .calls[0] as [string, { fsPath: string }];
    expect(command).toBe('vscode.open');
    expect(path.resolve(uri.fsPath)).toBe(path.join(repo, 'logo.png'));
  });

  it('has no review when the run changed nothing, and drops its snapshots', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const h = safetyHarness();
    const { count } = await h.run(repo, 'quiet', () => undefined);
    expect(count).toBe(0);
    expect(await h.safety.reviews.get('quiet')).toBeUndefined();
    expect(gitIn(repo, 'for-each-ref', 'refs/isarflow/')).toBe('');
    expect(fs.existsSync(path.join(h.storageDir, 'reviews', 'quiet'))).toBe(false);
    expect(h.history.setReview).not.toHaveBeenCalled();
  });

  it('takes the after snapshot on first use when VS Code closed during the run', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const h = safetyHarness();
    const session = await h.safety.begin({
      runId: 'closed',
      workflowUri: WORKFLOW_URI,
      folder: repo,
      isolation: 'workspace',
    });
    writeFiles(repo, { 'a.txt': 'changed\n' });
    expect(await session.finish({ skipSnapshot: true })).toBe(0);
    h.history.add('closed');

    // A new window: another service instance reads the saved state.
    const reopened = safetyHarness();
    const { createRunSafety } = await import('../../../src/safety/runSafety');
    const safety = createRunSafety({
      storageDir: h.storageDir,
      log: reopened.log,
      history: h.history.history,
      files: reopened.files.files,
      ui: reopened.ui.ui,
    });
    const review = await safety.reviews.get('closed');
    expect(review?.files).toEqual([expect.objectContaining({ path: 'a.txt', status: 'modified' })]);
    expect(h.history.setReview).toHaveBeenCalledWith('closed', {
      total: 1,
      kept: 0,
      reverted: 0,
      pending: 1,
    });
  });

  it('flags runs that worked in the same folder at the same time', async () => {
    const repo = initRepo({ 'a.txt': 'a\n' });
    const h = safetyHarness();
    const first = await h.safety.begin({
      runId: 'r1',
      workflowUri: WORKFLOW_URI,
      folder: repo,
      isolation: 'workspace',
    });
    const second = await h.safety.begin({
      runId: 'r2',
      workflowUri: 'file:///other',
      folder: repo,
      isolation: 'workspace',
    });
    writeFiles(repo, { 'a.txt': 'both\n' });
    await first.finish();
    await second.finish();
    expect((await h.safety.reviews.get('r1'))?.overlapping).toBe(true);
    expect((await h.safety.reviews.get('r2'))?.overlapping).toBe(true);

    const alone = await h.run(repo, 'r3', () => writeFiles(repo, { 'a.txt': 'alone\n' }));
    expect(alone.count).toBe(1);
    expect((await h.safety.reviews.get('r3'))?.overlapping).toBeUndefined();
  });

  it('lists at most 500 files; keeping all includes the ones not listed', async () => {
    const repo = initRepo({ 'keep.txt': 'k\n' });
    const h = safetyHarness();
    await h.run(repo, 'many', () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 503; i++) files[`gen/f${String(i).padStart(3, '0')}.txt`] = `${i}\n`;
      writeFiles(repo, files);
    });
    const review = await h.safety.reviews.get('many');
    expect(review?.files).toHaveLength(500);
    expect(review?.omitted).toBe(3);
    expect(review?.omittedPending).toBe(3);
    // Deciding every listed file leaves the files that are not listed waiting, and the card must say so.
    await h.safety.reviews.decide(
      'many',
      'kept',
      (review?.files ?? []).map((f) => f.path),
    );
    expect((await h.safety.reviews.get('many'))?.omittedPending).toBe(3);
    await h.safety.reviews.decide('many', 'kept');
    expect((await h.safety.reviews.get('many'))?.omittedPending).toBeUndefined();
    expect(h.history.records[0].review).toEqual({ total: 503, kept: 503, reverted: 0, pending: 0 });
  });

  it('refuses run ids that are not ids and paths that leave the folder', async () => {
    const { h, repo } = await changedRun();
    expect(await h.safety.reviews.get('../run-1')).toBeUndefined();
    await h.safety.reviews.decide('run-1', 'reverted', ['../outside.txt']);
    await h.safety.reviews.openDiff('run-1', '../outside.txt');
    expect(h.ui.ui.executeCommand).not.toHaveBeenCalled();
    expect(read(path.join(repo, 'src', 'app.ts'))).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('removes the snapshots and review of runs dropped from the history', async () => {
    const { repo, h } = await changedRun();
    h.changes.length = 0;
    h.history.removed.fire({ workflowUri: WORKFLOW_URI, runIds: ['run-1', 'unknown'] });
    await h.safety.whenIdle();
    expect(await h.safety.reviews.get('run-1')).toBeUndefined();
    expect(gitIn(repo, 'for-each-ref', 'refs/isarflow/')).toBe('');
    expect(fs.existsSync(path.join(h.storageDir, 'reviews', 'run-1'))).toBe(false);
    expect(h.changes).toEqual([{ runId: 'run-1', workflowUri: WORKFLOW_URI }]);
  });
});

describe('review of a workspace run without git', { timeout: 60_000 }, () => {
  it('lists only the files agents wrote and reverts them from the journal', async () => {
    const folder = tempDir('isar-plain-');
    writeFiles(folder, { 'a.txt': 'original a\r\n', 'same.txt': 'same', 'cmd.txt': 'before' });
    const h = safetyHarness();
    const { count } = await h.run(folder, 'plain', async ({ journal, root }) => {
      expect(root).toBe(folder);
      await journal.beforeWrite(path.join(folder, 'a.txt'), 'edit');
      writeFiles(folder, { 'a.txt': 'changed a\n' });
      await journal.beforeWrite(path.join(folder, 'new.txt'), 'edit');
      writeFiles(folder, { 'new.txt': 'new\n' });
      await journal.beforeWrite(path.join(folder, 'temp.txt'), 'edit');
      await journal.beforeWrite(path.join(folder, 'same.txt'), 'edit');
      writeFiles(folder, { 'cmd.txt': 'changed by a command' });
    });
    expect(count).toBe(2);
    const review = await h.safety.reviews.get('plain');
    expect(review).toMatchObject({ coverage: 'journal', isolation: 'workspace' });
    expect(review?.files).toEqual([
      {
        path: 'a.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
        stepIds: ['edit'],
        decision: 'pending',
        revertible: true,
      },
      {
        path: 'new.txt',
        status: 'added',
        additions: 1,
        deletions: 0,
        stepIds: ['edit'],
        decision: 'pending',
        revertible: true,
      },
    ]);

    writeFiles(folder, { 'new.txt': 'edited after the run\n' });
    h.ui.answers.push('Skip changed files');
    await h.safety.reviews.decide('plain', 'reverted');
    expect(h.ui.asked[0].message).toBe('1 file changed after the run: new.txt.');
    expect(read(path.join(folder, 'a.txt'))).toBe('original a\r\n');
    expect(read(path.join(folder, 'new.txt'))).toBe('edited after the run\n');
  });

  it('does not write or delete through a junction that a command put in place of a folder', async () => {
    const folder = tempDir('isar-plain-');
    const outside = tempDir('isar-outside-');
    writeFiles(folder, { 'src/app.txt': 'original\n' });
    writeFiles(outside, { 'app.txt': 'outside\n', 'new.txt': 'outside new\n' });
    const h = safetyHarness();
    await h.run(folder, 'linked', async ({ journal }) => {
      await journal.beforeWrite(path.join(folder, 'src', 'app.txt'), 'edit');
      writeFiles(folder, { 'src/app.txt': 'changed\n' });
      await journal.beforeWrite(path.join(folder, 'src', 'new.txt'), 'edit');
      writeFiles(folder, { 'src/new.txt': 'new\n' });
      fs.rmSync(path.join(folder, 'src'), { recursive: true });
      fs.symlinkSync(outside, path.join(folder, 'src'), 'junction');
    });

    await h.safety.reviews.decide('linked', 'reverted');
    expect(read(path.join(outside, 'app.txt'))).toBe('outside\n');
    expect(read(path.join(outside, 'new.txt'))).toBe('outside new\n');
    const files = (await h.safety.reviews.get('linked'))?.files ?? [];
    expect(files.map((f) => [f.path, f.decision, f.error])).toEqual([
      [
        'src/app.txt',
        'pending',
        'Could not revert src/app.txt: the path leads outside the workspace folder through a symbolic link or junction.',
      ],
      [
        'src/new.txt',
        'pending',
        'Could not revert src/new.txt: the path leads outside the workspace folder through a symbolic link or junction.',
      ],
    ]);
  });

  it('does not write through a symbolic link that a command put in place of a file', async (context) => {
    const folder = tempDir('isar-plain-');
    writeFiles(folder, { 'a.txt': 'a before\n', 'other.txt': 'other\n' });
    const h = safetyHarness();
    await h.run(folder, 'link', async ({ journal }) => {
      await journal.beforeWrite(path.join(folder, 'a.txt'), 'edit');
      fs.rmSync(path.join(folder, 'a.txt'));
      try {
        fs.symlinkSync(path.join(folder, 'other.txt'), path.join(folder, 'a.txt'));
      } catch {
        context.skip(); // Creating symbolic links needs extra rights on Windows.
      }
    });
    await h.safety.reviews.decide('link', 'reverted');
    expect(read(path.join(folder, 'other.txt'))).toBe('other\n');
    expect((await h.safety.reviews.get('link'))?.files[0]).toMatchObject({
      decision: 'pending',
      error: 'Could not revert a.txt: it is a symbolic link now. Restore it by hand.',
    });
  });

  it("can't revert a file whose original was too large to keep", async () => {
    const folder = tempDir('isar-plain-');
    writeFiles(folder, { 'huge.txt': 'x'.repeat(2 * 1024 * 1024 + 1) });
    const h = safetyHarness();
    await h.run(folder, 'huge', async ({ journal }) => {
      await journal.beforeWrite(path.join(folder, 'huge.txt'), 'edit');
      writeFiles(folder, { 'huge.txt': 'small now\n' });
    });
    const [file] = (await h.safety.reviews.get('huge'))?.files ?? [];
    expect(file).toMatchObject({ path: 'huge.txt', status: 'modified', revertible: false });
    await h.safety.reviews.decide('huge', 'reverted', ['huge.txt']);
    expect(read(path.join(folder, 'huge.txt'))).toBe('small now\n');
    expect((await h.safety.reviews.get('huge'))?.files[0]).toMatchObject({
      decision: 'pending',
      error:
        "huge.txt can't be reverted because its state before the run is unknown. Keep it, or restore it by hand.",
    });
  });
});
