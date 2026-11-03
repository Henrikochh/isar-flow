import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createHarness, every, type Harness, onSave, summary, workflowUri } from './harness';

const SYNC = workflowUri('sync');
const LINT = workflowUri('lint');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const STORM = "'Lint' started 10 times in 10 minutes, so its triggers are paused.";

describe('trigger service: schedule', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  it('starts every `every` with origin schedule', async () => {
    h = createHarness({ workflows: [summary('sync', [every('15m', 15 * MINUTE)])] });
    await h.settle();
    const created = Date.now();
    expect(h.service.state(SYNC).nextRunAt).toBe(created + 15 * MINUTE);
    await h.elapse(15 * MINUTE - 15_001);
    expect(h.runs.start).not.toHaveBeenCalled();
    await h.elapse(15_001);
    expect(h.runs.start).toHaveBeenCalledTimes(1);
    const [uri, inputs, options] = h.runs.start.mock.calls[0];
    expect(uri.toString()).toBe(SYNC);
    expect(inputs).toEqual({});
    expect(options?.origin).toEqual({ kind: 'trigger', trigger: 'schedule' });
    expect(h.service.state(SYNC)).toMatchObject({
      nextRunAt: Date.now() + 15 * MINUTE,
      lastFired: { kind: 'schedule', runId: 'run-1' },
    });
    expect(h.service.state(SYNC).lastFired).not.toHaveProperty('file');
  });

  it('skips a due run while the workflow runs and keeps its rhythm', async () => {
    h = createHarness({ workflows: [summary('sync', [every('1m', MINUTE)])] });
    await h.settle();
    h.startManually(SYNC);
    await h.elapse(MINUTE);
    expect(h.runs.start).not.toHaveBeenCalled();
    expect(h.service.state(SYNC)).toMatchObject({
      nextRunAt: Date.now() + MINUTE,
      lastFired: { kind: 'schedule', skipped: 'The workflow was already running.' },
    });
  });

  it('runs once after a sleep and says how many runs were missed', async () => {
    h = createHarness({ workflows: [summary('sync', [every('1h', HOUR)])] });
    await h.settle();
    // The computer sleeps: the clock jumps, timers do not run.
    vi.setSystemTime(Date.now() + 3 * HOUR + 10 * MINUTE);
    await h.elapse(15_000);
    expect(h.runs.start).toHaveBeenCalledTimes(1);
    expect(h.log.info).toHaveBeenCalledWith(
      "Missed 3 scheduled runs of 'Sync' while VS Code or the computer was asleep; running it once now.",
    );
    expect(h.service.state(SYNC).nextRunAt).toBe(Date.now() + HOUR);
    await h.elapse(15_000);
    expect(h.runs.start).toHaveBeenCalledTimes(1);
  });

  it('restarts the rhythm when the schedule changes and stops when it is removed', async () => {
    h = createHarness({ workflows: [summary('sync', [every('1h', HOUR)])] });
    await h.settle();
    await h.elapse(30 * MINUTE);
    h.setWorkflows([summary('sync', [every('2h', 2 * HOUR)])]);
    expect(h.service.state(SYNC).nextRunAt).toBe(Date.now() + 2 * HOUR);
    h.setWorkflows([summary('sync', [onSave('a.txt')])]);
    expect(h.service.state(SYNC).nextRunAt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await h.elapse(3 * HOUR);
    expect(h.runs.start).not.toHaveBeenCalled();
  });

  it('never runs schedules shorter than a minute or that cannot be read', async () => {
    h = createHarness({
      workflows: [summary('sync', [every('10s', 10_000)]), summary('lint', [every('soon', undefined)])],
    });
    await h.settle();
    expect(vi.getTimerCount()).toBe(0);
    await h.elapse(HOUR);
    expect(h.runs.start).not.toHaveBeenCalled();
  });

  it('advances silently while the triggers are paused', async () => {
    h = createHarness({ workflows: [summary('sync', [every('1m', MINUTE)])], enabled: false });
    await h.settle();
    expect(h.service.state(SYNC).nextRunAt).toBeUndefined();
    await h.elapse(5 * MINUTE);
    expect(h.runs.start).not.toHaveBeenCalled();
    h.setEnabled(true);
    expect(h.service.state(SYNC).nextRunAt).toBeGreaterThan(Date.now());
    await h.elapse(MINUTE);
    expect(h.runs.start).toHaveBeenCalledTimes(1);
    expect(h.log.info).not.toHaveBeenCalledWith(expect.stringContaining('Missed'));
  });

  it('starts at most once per tick', async () => {
    h = createHarness({ workflows: [summary('sync', [every('1m', MINUTE)])] });
    await h.settle();
    h.runs.start.mockImplementation(async () => 'run-x');
    await h.elapse(MINUTE);
    expect(h.runs.start).toHaveBeenCalledTimes(1);
    await h.elapse(15_000);
    expect(h.runs.start).toHaveBeenCalledTimes(1);
  });
});

describe('trigger service: storm guard', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  /** One save-triggered run that ends right away (the quiet time after a run is waited out too). */
  async function saveAndRun(file = '/ws/src/a.ts') {
    h.save(file);
    await h.elapse(2_000);
    const runId = h.runs.active(LINT)[0]?.runId;
    if (runId) h.finish(runId);
    await h.elapse(3_000);
  }

  it('pauses after 10 starts within 10 minutes', async () => {
    h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
    await h.settle();
    for (let i = 0; i < 10; i++) await saveAndRun();
    expect(h.runs.start).toHaveBeenCalledTimes(10);
    h.ui.showWarning.mockResolvedValueOnce('Open workflow');
    await saveAndRun();
    expect(h.runs.start).toHaveBeenCalledTimes(10);
    expect(h.service.state(LINT)).toMatchObject({
      status: 'paused',
      pausedReason: 'limited',
      pausedMessage: `${STORM} Resume them when you're ready.`,
    });
    expect(h.ui.showWarning).toHaveBeenCalledWith(STORM, 'Resume triggers', 'Open workflow');
    expect(h.ui.executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      vscode.Uri.parse(LINT),
      'isarFlow.workflowEditor',
    );
    expect(h.log.warn).toHaveBeenCalledWith(STORM);

    // While limited, events are dropped.
    await saveAndRun();
    expect(h.runs.start).toHaveBeenCalledTimes(10);

    h.service.resume(LINT);
    expect(h.service.state(LINT).status).toBe('active');
    await saveAndRun();
    expect(h.runs.start).toHaveBeenCalledTimes(11);
  });

  it('resumes from the warning', async () => {
    h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
    await h.settle();
    for (let i = 0; i < 10; i++) await saveAndRun();
    h.ui.showWarning.mockResolvedValueOnce('Resume triggers');
    await saveAndRun();
    await h.settle();
    expect(h.service.state(LINT).status).toBe('active');
  });

  it('forgets starts older than 10 minutes', async () => {
    h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
    await h.settle();
    for (let i = 0; i < 10; i++) await saveAndRun();
    await h.elapse(10 * MINUTE);
    await saveAndRun();
    expect(h.runs.start).toHaveBeenCalledTimes(11);
    expect(h.service.state(LINT).status).toBe('active');
  });

  it('does not count scheduled starts', async () => {
    h = createHarness({ workflows: [summary('lint', [every('1m', MINUTE)])] });
    await h.settle();
    for (let i = 0; i < 12; i++) {
      await h.elapse(MINUTE);
      const runId = h.runs.active(LINT)[0]?.runId;
      if (runId) h.finish(runId);
    }
    expect(h.runs.start).toHaveBeenCalledTimes(12);
    expect(h.service.state(LINT).status).toBe('active');
  });

  it('ignores resume for workflows that are not limited', async () => {
    h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
    await h.settle();
    h.changes.length = 0;
    h.service.resume(LINT);
    h.service.resume(workflowUri('unknown'));
    expect(h.changes).toEqual([]);
  });
});
