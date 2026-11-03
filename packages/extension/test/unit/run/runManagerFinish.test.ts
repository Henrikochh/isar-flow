import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunReview } from '@isar-flow/core';
import type { RunFinished } from '../../../src/contracts';
import { flush } from './fakes';
import { setup, untilAborted, type Setup } from './managerSetup';

const FAILING = `version: 1
name: Build
steps:
  - id: tests
    type: console
    run: npm test
`;

const exitTwo: Setup['runCommand'] = async () => ({
  exitCode: 2,
  stdout: '',
  stderr: 'boom',
  output: 'boom',
  timedOut: false,
});

function review(paths: string[]): RunReview {
  return {
    runId: 'r',
    coverage: 'git',
    isolation: 'workspace',
    files: paths.map((p) => ({
      path: p,
      status: 'modified',
      stepIds: [],
      decision: 'pending',
      revertible: true,
    })),
  };
}

/** A run manager without a visible workflow editor, so finished runs notify. */
function hidden(options: Setup = {}) {
  const t = setup({ editorVisible: false, ...options });
  const finished: RunFinished[] = [];
  t.manager.onDidFinish((run) => finished.push(run));
  return { ...t, finished };
}

async function run(t: ReturnType<typeof hidden>, options = {}) {
  const runId = (await t.manager.start(t.uri, {}, options)) as string;
  await t.manager.whenFinished(runId);
  await flush();
  return runId;
}

describe('createRunManager finished runs', () => {
  it('fires onDidFinish after the history save and the review with absolute changed files', async () => {
    const t = hidden({ safety: { changed: 2 } });
    t.safety.safety.reviews.get = vi.fn(async () => review(['src/a.ts', 'docs/b.md']));
    const order: string[] = [];
    t.manager.onDidFinish(() => order.push(`finish:${t.history.list().length}`));
    const runId = await run(t, { origin: { kind: 'selection' } });
    expect(t.finished).toEqual([
      {
        runId,
        workflowUri: t.uri.toString(),
        workflowName: 'Build',
        status: 'success',
        view: expect.objectContaining({ runId, status: 'success' }),
        changedFiles: [path.join('/ws', 'src/a.ts'), path.join('/ws', 'docs/b.md')],
        origin: { kind: 'selection' },
        simulated: false,
      },
    ]);
    expect(order).toEqual(['finish:1']);
    expect(t.safety.order).toEqual(['begin', 'finish', 'publish']);
  });

  it('fires onDidFinish for simulated runs and runs that stop before the engine', async () => {
    const t = hidden({
      safety: { canIsolate: true, beginError: 'no space' },
      text: `version: 1
name: Build
isolation: worktree
steps:
  - id: build
    type: console
    run: npm run build
`,
    });
    await run(t);
    await run(t, { simulate: true });
    expect(t.finished.map((f) => [f.status, f.simulated, f.changedFiles, f.origin])).toEqual([
      ['failure', false, [], { kind: 'manual' }],
      ['success', true, [], { kind: 'manual' }],
    ]);
  });

  it('says how a manual run went when no editor of the workflow is visible', async () => {
    const t = hidden({ click: 'Open run' });
    const runId = await run(t);
    expect(t.notifications).toEqual([
      {
        kind: 'info',
        message: expect.stringMatching(/^Build succeeded in [\d.]+s\.$/),
        buttons: ['Open run'],
      },
    ]);
    expect(t.ui.executeCommand).toHaveBeenCalledWith('isarFlow.internal.showRun', t.uri.toString(), runId);
  });

  it('names the failed block', async () => {
    const t = hidden({ text: FAILING, runCommand: exitTwo });
    await run(t);
    expect(t.notifications).toEqual([
      { kind: 'error', message: expect.stringMatching(/^Build failed at tests: /), buttons: ['Open run'] },
    ]);
  });

  it('offers the review when a run changed files', async () => {
    const t = hidden({ safety: { changed: 3 }, click: 'Review changes' });
    const runId = await run(t);
    expect(t.notifications).toEqual([
      {
        kind: 'info',
        message: expect.stringMatching(/^Build succeeded in [\d.]+s and changed 3 files\.$/),
        buttons: ['Review changes', 'Open run'],
      },
    ]);
    expect(t.ui.executeCommand).toHaveBeenCalledWith('isarFlow.internal.showRun', t.uri.toString(), runId);
  });

  it('stays quiet about cancelled runs and successful trigger runs without changes', async () => {
    const cancelled = hidden({ runCommand: untilAborted });
    const runId = (await cancelled.manager.start(cancelled.uri)) as string;
    cancelled.manager.cancel(runId);
    await cancelled.manager.whenFinished(runId);
    await flush();
    expect(cancelled.notifications).toEqual([]);

    const trigger = hidden({ settings: { confirmCommands: false } });
    await run(trigger, { origin: { kind: 'trigger', trigger: 'schedule' } });
    expect(trigger.notifications).toEqual([]);
  });

  it('tells about Copilot runs only when they changed files', async () => {
    const quiet = hidden();
    await run(quiet, { origin: { kind: 'copilot' } });
    expect(quiet.notifications).toEqual([]);

    const changed = hidden({ safety: { changed: 1 } });
    await run(changed, { origin: { kind: 'copilot' } });
    expect(changed.notifications).toEqual([
      { kind: 'info', message: 'Build changed 1 file.', buttons: ['Review changes'] },
    ]);
  });

  it('says a simulated run finished', async () => {
    const t = hidden();
    await run(t, { simulate: true });
    expect(t.notifications).toEqual([
      { kind: 'info', message: 'Simulated run of Build finished.', buttons: ['Open run'] },
    ]);
  });

  it('with a visible editor only reports changed files', async () => {
    const t = setup({ safety: { changed: 2 } });
    const finished = vi.fn();
    t.manager.onDidFinish(finished);
    await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    await flush();
    expect(t.notifications).toEqual([
      { kind: 'info', message: 'Build changed 2 files.', buttons: ['Review changes'] },
    ]);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('counts an attached approval editor as visible too', async () => {
    const t = hidden();
    t.approvals.attach(t.uri.toString());
    await run(t);
    expect(t.notifications).toEqual([]);
  });

  it('keeps going when the review cannot be read', async () => {
    const t = hidden({ safety: { changed: 1 } });
    t.safety.safety.reviews.get = vi.fn(async () => Promise.reject(new Error('pruned')));
    await run(t);
    expect(t.finished[0].changedFiles).toEqual([]);
    expect(t.logLines).toContainEqual(expect.stringContaining('pruned'));
  });

  it('does not announce runs stopped by shutdown', async () => {
    const t = hidden({ runCommand: untilAborted });
    await t.manager.start(t.uri);
    await flush();
    await t.manager.shutdown();
    await flush();
    expect(t.finished).toEqual([]);
    expect(t.notifications).toEqual([]);
  });
});
