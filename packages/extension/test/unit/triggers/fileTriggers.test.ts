import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { createHarness, type Harness, onChange, onSave, ROOT, ROOT_B, summary, workflowUri } from './harness';

const LINT = workflowUri('lint');

describe('trigger service: save and change', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  describe('save', () => {
    it('starts the workflow 2 s after a matching save, with the file as origin', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/**/*.ts')])] });
      await h.settle();
      h.save('/ws/src/app.ts');
      await h.elapse(1_999);
      expect(h.runs.start).not.toHaveBeenCalled();
      await h.elapse(1);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
      const [uri, inputs, options] = h.runs.start.mock.calls[0];
      expect(uri.toString()).toBe(LINT);
      expect(inputs).toEqual({});
      expect(Object.keys(options ?? {}).sort()).toEqual(['onRefused', 'origin']);
      expect(options?.origin).toEqual({ kind: 'trigger', trigger: 'save', file: 'src/app.ts' });
      expect(h.service.state(LINT).lastFired).toEqual({
        at: Date.now(),
        kind: 'save',
        file: 'src/app.ts',
        runId: 'run-1',
      });
      expect(h.changes).toContain(LINT);
    });

    it('coalesces events and uses the last one as origin', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
      await h.settle();
      for (const name of ['a', 'b', 'c', 'd']) {
        h.save(`/ws/src/${name}.ts`);
        await h.elapse(1_500);
      }
      expect(h.runs.start).not.toHaveBeenCalled();
      await h.elapse(500);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
      expect(h.runs.start.mock.calls[0][2]?.origin).toEqual({
        kind: 'trigger',
        trigger: 'save',
        file: 'src/d.ts',
      });
    });

    it('ignores files that do not match, are excluded or are outside the folder', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/**', '!src/gen/**')])] });
      await h.settle();
      h.save('/ws/docs/a.md');
      h.save('/ws/src/gen/a.ts');
      h.save('/other/src/a.ts');
      h.save('/elsewhere/src/a.ts');
      await h.elapse(5_000);
      expect(h.runs.start).not.toHaveBeenCalled();
    });

    it("never starts on its own file or Isar Flow's memory", async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('**/*')])] });
      await h.settle();
      h.save(vscode.Uri.parse(LINT).fsPath);
      h.save('/ws/.isarflow/memory.md');
      h.save('/ws/node_modules/x/index.js');
      h.save('/ws/.git/COMMIT_EDITMSG');
      await h.elapse(5_000);
      expect(h.runs.start).not.toHaveBeenCalled();
    });

    it('starts every workflow a save matches', async () => {
      h = createHarness({
        workflows: [summary('lint', [onSave('src/*.ts')]), summary('test', [onSave('src/**')])],
      });
      await h.settle();
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start.mock.calls.map(([uri]) => uri.toString()).sort()).toEqual([
        LINT,
        workflowUri('test'),
      ]);
    });

    it('matches files relative to the folder of each workflow (multi-root)', async () => {
      h = createHarness({
        workflows: [
          summary('lint', [onSave('src/*.ts')]),
          summary('docs', [onSave('src/*.ts')], { root: ROOT_B }),
        ],
      });
      await h.settle();
      h.save('/other/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
      expect(h.runs.start.mock.calls[0][0].toString()).toBe(workflowUri('docs', ROOT_B));
      expect(h.runs.start.mock.calls[0][2]?.origin).toMatchObject({ file: 'src/a.ts' });
    });

    it('ignores file events of workflows outside all folders', async () => {
      const outside = { ...summary('loose', [onSave('**')]), uri: 'file:///tmp/loose.workflow.yaml' };
      h = createHarness({ workflows: [outside] });
      await h.settle();
      h.save('/tmp/a.ts');
      await h.elapse(5_000);
      expect(h.runs.start).not.toHaveBeenCalled();
    });
  });

  describe('change', () => {
    it('watches each positive pattern in the workflow folder', async () => {
      h = createHarness({ workflows: [summary('lint', [onChange('docs/**', '*.md', '!docs/gen/**')])] });
      await h.settle();
      expect(h.watchers.map((w) => w.pattern.pattern)).toEqual(['docs/**', '*.md']);
      expect(h.watchers.every((w) => String(w.pattern.baseUri) === String(ROOT))).toBe(true);
    });

    it('starts on create, change and delete events', async () => {
      h = createHarness({ workflows: [summary('lint', [onChange('docs/**')])] });
      await h.settle();
      h.watchers[0].fire('/ws/docs/a.md');
      await h.elapse(2_000);
      expect(h.runs.start.mock.calls[0][2]?.origin).toEqual({
        kind: 'trigger',
        trigger: 'change',
        file: 'docs/a.md',
      });
    });

    it('drops excluded files', async () => {
      h = createHarness({ workflows: [summary('lint', [onChange('docs/**', '!docs/gen/**')])] });
      await h.settle();
      h.watchers[0].fire('/ws/docs/gen/a.md');
      await h.elapse(5_000);
      expect(h.runs.start).not.toHaveBeenCalled();
    });

    it('starts once for a save that also changes the file on disk', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts'), onChange('src/*.ts')])] });
      await h.settle();
      h.save('/ws/src/a.ts');
      h.watchers[0].fire('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
      expect(h.runs.start.mock.calls[0][2]?.origin).toMatchObject({ trigger: 'change' });
    });

    it('starts once for a branch switch that touches 1,000 files', async () => {
      h = createHarness({ workflows: [summary('lint', [onChange('src/**')])] });
      await h.settle();
      for (let i = 0; i < 1_000; i++) {
        h.watchers[0].fire(`/ws/src/file-${i}.ts`);
        if (i % 100 === 0) await h.elapse(200);
      }
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
    });

    it('keeps watchers while the triggers stay the same and replaces them when they change', async () => {
      h = createHarness({ workflows: [summary('lint', [onChange('docs/**')])] });
      await h.settle();
      const [first] = h.watchers;
      h.setWorkflows([summary('lint', [onChange('docs/**')], { description: 'changed' })]);
      expect(h.watchers).toHaveLength(1);
      h.setWorkflows([summary('lint', [onChange('notes/**')])]);
      expect(first.disposed).toBe(true);
      expect(h.watchers.map((w) => w.pattern.pattern)).toEqual(['docs/**', 'notes/**']);
    });

    it('disposes the watchers when the workflow is deleted, renamed or loses its triggers', async () => {
      h = createHarness({
        workflows: [summary('lint', [onChange('docs/**')]), summary('docs', [onChange('a/**')])],
      });
      await h.settle();
      const [lint, docs] = h.watchers;
      h.setWorkflows([summary('docs', [])]);
      expect(lint.disposed).toBe(true);
      expect(docs.disposed).toBe(true);
      expect(h.service.state(LINT)).toEqual({ triggers: [], status: 'active' });
      expect(h.service.list()).toEqual([]);
      expect(h.changes).toEqual(expect.arrayContaining([LINT, workflowUri('docs')]));
    });

    it('disposes the watchers while the workflow has problems', async () => {
      h = createHarness({ workflows: [summary('lint', [onChange('docs/**')])] });
      await h.settle();
      h.setWorkflows([summary('lint', [onChange('docs/**')], { valid: false })]);
      expect(h.watchers[0].disposed).toBe(true);
      h.setWorkflows([summary('lint', [onChange('docs/**')])]);
      expect(h.watchers).toHaveLength(2);
      expect(h.watchers[1].disposed).toBe(false);
    });
  });

  describe('own writes', () => {
    it('drops events while a run of the workflow is active', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
      await h.settle();
      const runId = h.startManually(LINT);
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).not.toHaveBeenCalled();
      expect(h.service.state(LINT).lastFired).toBeUndefined();
      h.finish(runId);
    });

    it('drops events for 3 s after a run and changed files for 10 s', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
      await h.settle();
      const runId = h.startManually(LINT);
      h.finish(runId, [vscode.Uri.file('/ws/src/changed.ts').fsPath]);
      h.save('/ws/src/other.ts');
      await h.elapse(2_999);
      h.save('/ws/src/changed.ts');
      await h.elapse(2_000);
      expect(h.runs.start).not.toHaveBeenCalled();
      h.save('/ws/src/other.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
      h.finish('run-2');
      await h.elapse(3_100);
      h.save('/ws/src/changed.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(2);
    });

    it('drops changed files only for the workflow that changed them', async () => {
      h = createHarness({
        workflows: [summary('lint', [onSave('src/*.ts')]), summary('test', [onSave('src/*.ts')])],
      });
      await h.settle();
      const runId = h.startManually(LINT);
      h.finish(runId, [vscode.Uri.file('/ws/src/a.ts').fsPath]);
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start.mock.calls.map(([uri]) => uri.toString())).toEqual([workflowUri('test')]);
    });

    it('drops events after a run ended even without a finish event', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])], minimalRuns: true });
      await h.settle();
      const runId = h.startManually(LINT);
      h.endQuietly(runId);
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).not.toHaveBeenCalled();
      await h.elapse(1_000);
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
    });

    it('does not start again when the review of its run reverts or keeps files later', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
      await h.settle();
      const runId = h.startManually(LINT);
      h.finish(runId, [vscode.Uri.file('/ws/src/a.ts').fsPath]);
      await h.elapse(60_000);
      // Revert saves the file through VS Code, then the review changes.
      h.save('/ws/src/a.ts');
      await h.elapse(500);
      h.reviewChanged(runId, LINT, ['src/a.ts']);
      await h.elapse(5_000);
      // A late event of the same write.
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).not.toHaveBeenCalled();
      h.save('/ws/src/b.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
      expect(h.runs.start.mock.calls[0][2]?.origin).toMatchObject({ file: 'src/b.ts' });
    });

    it('starts on review changes of other workflows and on later edits of reverted files', async () => {
      h = createHarness({
        workflows: [summary('lint', [onSave('src/*.ts')]), summary('docs', [onSave('docs/*.md')])],
      });
      await h.settle();
      const runId = h.startManually(workflowUri('docs'));
      h.finish(runId, [vscode.Uri.file('/ws/src/a.ts').fsPath]);
      await h.elapse(60_000);
      h.save('/ws/src/a.ts');
      h.reviewChanged(runId, workflowUri('docs'), ['src/a.ts']);
      await h.elapse(2_000);
      expect(h.runs.start.mock.calls.map(([uri]) => uri.toString())).toEqual([LINT]);
      h.finish('run-2');
      await h.elapse(10_000);

      h.reviewChanged('run-2', LINT, ['src/a.ts']);
      await h.elapse(10_000);
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(2);
    });

    it('logs a review that cannot be read and keeps the pending start', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
      await h.settle();
      h.runs.reviews.get.mockRejectedValueOnce(new Error('disk full'));
      h.save('/ws/src/a.ts');
      h.reviewChanged('run-9', LINT, ['src/a.ts']);
      await h.elapse(2_000);
      expect(h.log.warn).toHaveBeenCalledWith('Could not read the review of run run-9: disk full');
      expect(h.runs.start).toHaveBeenCalledTimes(1);
    });

    it('records a skipped start when a run began during the debounce', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
      await h.settle();
      h.save('/ws/src/a.ts');
      await h.elapse(1_000);
      h.startManually(LINT);
      await h.elapse(1_000);
      expect(h.runs.start).not.toHaveBeenCalled();
      expect(h.service.state(LINT).lastFired).toEqual({
        at: Date.now(),
        kind: 'save',
        file: 'src/a.ts',
        skipped: 'The workflow was already running.',
      });
    });
  });

  it('uses the folder of the workflow for patterns', () => {
    h = createHarness({ workflows: [summary('lint', [onChange('a/**')])] });
    expect(String(h.watchers[0].pattern.baseUri)).toBe(String(ROOT));
  });
});
