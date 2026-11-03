import { describe, expect, it, vi } from 'vitest';
import { createRunView, type RunView } from '@isar-flow/core';
import { createRunHistory, MAX_RUN_BYTES, trimRunView } from '../../../src/run/history';
import { FakeMemento, memoryStore } from './fakes';

const A = 'file:///ws/a.workflow.yaml';
const B = 'file:///ws/b.workflow.yaml';

function view(runId: string, startedAt: number, extra: Partial<RunView> = {}): RunView {
  return {
    ...createRunView(runId, 'Workflow', startedAt),
    status: 'success',
    durationMs: 1200,
    ...extra,
  };
}

describe('trimRunView', () => {
  it('keeps the last 300 log entries per step', () => {
    const logs = Array.from({ length: 500 }, (_, i) => ({ stream: 'stdout' as const, text: `line ${i}\n` }));
    const trimmed = trimRunView(view('r', 1, { steps: { s: { status: 'success', executions: 1, logs } } }));
    expect(trimmed.steps.s.logs).toHaveLength(300);
    expect(trimmed.steps.s.logs[0].text).toBe('line 200\n');
    expect(trimmed.steps.s.logsTruncated).toBe(true);
  });

  it('truncates strings longer than 100 KB, also inside outputs', () => {
    const big = 'x'.repeat(150_000);
    const trimmed = trimRunView(
      view('r', 1, {
        steps: {
          s: {
            status: 'success',
            executions: 1,
            logs: [{ stream: 'stdout', text: big }],
            output: { status: 'success', stdout: big, nested: { deep: [big] } },
          },
        },
      }),
    );
    const step = trimmed.steps.s;
    expect(step.logs[0].text.length).toBeLessThan(110_000);
    expect(step.logs[0].text).toContain('truncated');
    expect((step.output?.stdout as string).length).toBeLessThan(110_000);
    const nested = step.output?.nested as { deep: string[] };
    expect(nested.deep[0].length).toBeLessThan(110_000);
  });

  it('keeps the whole run under 1 MB', () => {
    const steps: RunView['steps'] = {};
    for (let i = 0; i < 40; i++) {
      steps[`s${i}`] = {
        status: 'success',
        executions: 1,
        logs: Array.from({ length: 300 }, () => ({ stream: 'stdout' as const, text: 'y'.repeat(2_000) })),
        output: { status: 'success', stdout: 'z'.repeat(90_000) },
      };
    }
    const trimmed = trimRunView(view('r', 1, { steps }));
    expect(Buffer.byteLength(JSON.stringify(trimmed), 'utf8')).toBeLessThanOrEqual(MAX_RUN_BYTES);
    expect(Object.keys(trimmed.steps)).toHaveLength(40);
    expect(trimmed.steps.s39.status).toBe('success');
  });

  it('leaves small views untouched', () => {
    const small = view('r', 1, {
      steps: { s: { status: 'success', executions: 1, logs: [{ stream: 'stdout', text: 'ok\n' }] } },
    });
    expect(trimRunView(small)).toEqual(small);
  });
});

describe('createRunHistory', () => {
  it('saves views, caches them and lists summaries newest first', async () => {
    const store = memoryStore();
    const history = createRunHistory(store, new FakeMemento(), () => 50);
    const changed = vi.fn();
    history.onDidChange(changed);

    await history.save(view('run-1', 100), A);
    await history.save(view('run-2', 300, { status: 'failure', error: 'Boom' }), B);
    await history.save(view('run-3', 200), A);

    expect(history.list().map((r) => r.runId)).toEqual(['run-2', 'run-3', 'run-1']);
    expect(history.list(A).map((r) => r.runId)).toEqual(['run-3', 'run-1']);
    expect(history.list(B)[0]).toMatchObject({ workflowUri: B, status: 'failure', error: 'Boom' });
    expect(history.get('run-2')?.error).toBe('Boom');
    expect(JSON.parse(store.files.get('run-1') ?? '{}').runId).toBe('run-1');
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('enforces the limit per workflow and deletes old files', async () => {
    const store = memoryStore();
    let limit = 2;
    const history = createRunHistory(store, new FakeMemento(), () => limit);
    await history.save(view('a1', 1), A);
    await history.save(view('b1', 2), B);
    await history.save(view('a2', 3), A);
    await history.save(view('a3', 4), A);

    expect(history.list(A).map((r) => r.runId)).toEqual(['a3', 'a2']);
    expect(history.list(B).map((r) => r.runId)).toEqual(['b1']);
    expect(store.files.has('a1')).toBe(false);
    expect(history.get('a1')).toBeUndefined();

    limit = 1;
    await history.save(view('a4', 5), A);
    expect(history.list(A).map((r) => r.runId)).toEqual(['a4']);
    expect([...store.files.keys()].sort()).toEqual(['a4', 'b1']);
  });

  it('replaces an entry saved twice under the same run id', async () => {
    const history = createRunHistory(memoryStore(), new FakeMemento(), () => 50);
    await history.save(view('r', 1, { status: 'running' }), A);
    await history.save(view('r', 1, { status: 'cancelled' }), A);
    expect(history.list()).toHaveLength(1);
    expect(history.list()[0].status).toBe('cancelled');
  });

  it('reloads the index from the memento and reads views lazily', async () => {
    const store = memoryStore();
    const memento = new FakeMemento();
    await createRunHistory(store, memento, () => 50).save(view('old', 1), A);

    const reopened = createRunHistory(store, memento, () => 50);
    expect(reopened.list(A).map((r) => r.runId)).toEqual(['old']);
    expect(reopened.get('old')).toBeUndefined();
    expect((await reopened.getAsync('old'))?.runId).toBe('old');
    expect(reopened.get('old')?.runId).toBe('old');
  });

  it('warms the cache with loadAll and tolerates missing or broken files', async () => {
    const store = memoryStore();
    const memento = new FakeMemento();
    const first = createRunHistory(store, memento, () => 50);
    await first.save(view('one', 1), A);
    await first.save(view('two', 2), A);
    await first.save(view('three', 3), B);
    store.files.delete('two');
    store.files.set('three', '{ not json');

    const reopened = createRunHistory(store, memento, () => 50);
    await reopened.loadAll();
    expect(reopened.get('one')?.runId).toBe('one');
    expect(reopened.get('two')).toBeUndefined();
    expect(reopened.get('three')).toBeUndefined();
    expect(await reopened.getAsync('missing')).toBeUndefined();
  });

  it('serializes concurrent saves without losing index entries', async () => {
    const history = createRunHistory(memoryStore(), new FakeMemento(), () => 50);
    await Promise.all([1, 2, 3, 4, 5].map((i) => history.save(view(`r${i}`, i), A)));
    expect(history.list(A)).toHaveLength(5);
  });
});

describe('run history and reviews', () => {
  it('stores review counts in the summary and keeps them when the run is saved again', async () => {
    const memento = new FakeMemento();
    const history = createRunHistory(memoryStore(), memento, () => 50);
    const changed = vi.fn();
    await history.save(view('r1', 1), A);
    history.onDidChange(changed);

    await history.setReview?.('r1', { total: 3, kept: 1, reverted: 1, pending: 1 });
    expect(history.list(A)[0].review).toEqual({ total: 3, kept: 1, reverted: 1, pending: 1 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(createRunHistory(memoryStore(), memento, () => 50).list(A)[0].review).toEqual({
      total: 3,
      kept: 1,
      reverted: 1,
      pending: 1,
    });

    await history.save(view('r1', 1, { status: 'failure' }), A);
    expect(history.list(A)[0]).toMatchObject({ status: 'failure', review: { pending: 1 } });

    await history.setReview?.('unknown', { total: 1, kept: 1, reverted: 0, pending: 0 });
    expect(history.list().map((r) => r.runId)).toEqual(['r1']);
  });

  it('tells which runs the history limit removed', async () => {
    const history = createRunHistory(memoryStore(), new FakeMemento(), () => 1);
    const removed = vi.fn();
    history.onDidRemove?.(removed);
    await history.save(view('a1', 1), A);
    await history.save(view('b1', 2), B);
    expect(removed).not.toHaveBeenCalled();
    await history.save(view('a2', 3), A);
    expect(removed).toHaveBeenCalledWith({ workflowUri: A, runIds: ['a1'] });
  });

  it('keeps block metrics when a run is cut down to its skeleton', () => {
    const steps: RunView['steps'] = {};
    for (let i = 0; i < 6000; i++) {
      steps[`s${i}`] = {
        status: 'success',
        executions: 1,
        logs: [],
        output: {
          status: 'success',
          ...Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`k${k}`, 'v'.repeat(150)])),
        },
        metrics: { durationMs: 10, executions: 1, usage: { inputTokens: 5, outputTokens: 2 }, model: 'm' },
      };
    }
    const trimmed = trimRunView(view('big', 1, { steps }));
    expect(trimmed.steps.s0.output).toBeUndefined();
    expect(trimmed.steps.s0.metrics).toEqual({
      durationMs: 10,
      executions: 1,
      usage: { inputTokens: 5, outputTokens: 2 },
      model: 'm',
    });
  });
});
