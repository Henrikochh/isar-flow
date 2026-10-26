import { describe, expect, it } from 'vitest';
import type { RunEvent, StepOutput } from '../../src/engine/types';
import { createRunView, MAX_LOG_LINES, reduceRunEvent, runRecordSummary } from '../../src/run';
import type { RunView } from '../../src/run/types';
import { FakeHost } from '../fakes/fakeHost';
import { run, workflow } from '../engine/helpers';

const R = 'run-1';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const start = (
  stepId: string,
  at = 10,
  extra: Partial<Extract<RunEvent, { type: 'step-start' }>> = {},
): RunEvent => ({
  type: 'step-start',
  runId: R,
  stepId,
  stepType: 'console',
  at,
  ...extra,
});
const end = (
  stepId: string,
  status: StepOutput['status'],
  output: Record<string, unknown> = {},
  error?: string,
): RunEvent => ({
  type: 'step-end',
  runId: R,
  stepId,
  status,
  output: { ...output, status, durationMs: 5 },
  durationMs: 5,
  at: 20,
  ...(error !== undefined && { error }),
});
const log = (
  stepId: string,
  text: string,
  stream: 'stdout' | 'stderr' | 'agent' | 'info' = 'stdout',
): RunEvent => ({
  type: 'step-log',
  runId: R,
  stepId,
  stream,
  text,
});

function reduceAll(events: RunEvent[], initial: RunView | null = null): RunView {
  return events.reduce<RunView | null>((view, event) => reduceRunEvent(view, event), initial) as RunView;
}

const runStart: RunEvent = {
  type: 'run-start',
  runId: R,
  workflowName: 'Flow',
  startedAt: 1,
  inputs: { task: 'x' },
};

describe('createRunView', () => {
  it('creates an empty running view', () => {
    expect(createRunView(R, 'Flow', 5)).toEqual({
      runId: R,
      workflowName: 'Flow',
      status: 'running',
      startedAt: 5,
      inputs: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: {},
    });
    expect(createRunView(R, 'Flow', 5, { a: 1 }).inputs).toEqual({ a: 1 });
  });
});

describe('reduceRunEvent', () => {
  it('starts a view from run-start, also when given null', () => {
    const view = reduceRunEvent(null, runStart);
    expect(view).toEqual(createRunView(R, 'Flow', 1, { task: 'x' }));
    const previous = reduceAll([runStart, start('a')]);
    expect(reduceRunEvent(previous, { ...runStart, runId: 'run-2' })).toMatchObject({
      runId: 'run-2',
      steps: {},
    });
  });

  it('tracks a step through start, logs and end', () => {
    const view = reduceAll([
      runStart,
      start('a', 10, { detail: 'npm test', iteration: 2 }),
      log('a', 'hello\n'),
      end('a', 'success', { exitCode: 0 }),
    ]);
    expect(view.steps.a).toEqual({
      status: 'success',
      executions: 1,
      iteration: 2,
      detail: 'npm test',
      startedAt: 10,
      logs: [{ stream: 'stdout', text: 'hello\n' }],
      output: { exitCode: 0, status: 'success', durationMs: 5 },
      durationMs: 5,
    });
  });

  it('keeps error on failed steps and clears it on the next execution', () => {
    let view = reduceAll([runStart, start('a'), end('a', 'failure', {}, 'Command exited with code 1')]);
    expect(view.steps.a).toMatchObject({ status: 'failure', error: 'Command exited with code 1' });
    view = reduceAll([start('a', 30, { detail: 'second' })], view);
    expect(view.steps.a).toMatchObject({
      status: 'running',
      executions: 2,
      startedAt: 30,
      detail: 'second',
      logs: [],
    });
    expect(view.steps.a.error).toBeUndefined();
    expect(view.steps.a.output).toBeUndefined();
    view = reduceAll([end('a', 'success')], view);
    expect(view.steps.a.error).toBeUndefined();
  });

  it('tracks the innermost running block as active', () => {
    let view = reduceAll([
      runStart,
      start('loop'),
      { type: 'loop-iteration', runId: R, stepId: 'loop', iteration: 1, maxIterations: 3 },
    ]);
    expect(view.activeStepId).toBe('loop');
    view = reduceAll([start('gate'), start('fix')], view);
    expect(view.activeStepId).toBe('fix');
    view = reduceAll([end('fix', 'success')], view);
    expect(view.activeStepId).toBe('gate');
    view = reduceAll([end('gate', 'success')], view);
    expect(view.activeStepId).toBe('loop');
    view = reduceAll(
      [{ type: 'loop-iteration', runId: R, stepId: 'loop', iteration: 2, maxIterations: 3 }, start('fix')],
      view,
    );
    expect(view.activeStepId).toBe('fix');
    expect(view.steps.fix.executions).toBe(2);
    view = reduceAll([end('fix', 'success'), end('loop', 'success')], view);
    expect(view.activeStepId).toBeUndefined();
  });

  it('records loop progress', () => {
    const view = reduceAll([
      runStart,
      start('loop'),
      { type: 'loop-iteration', runId: R, stepId: 'loop', iteration: 1, maxIterations: 5 },
      { type: 'loop-iteration', runId: R, stepId: 'loop', iteration: 2, maxIterations: 5 },
    ]);
    expect(view.steps.loop.loop).toEqual({ iteration: 2, maxIterations: 5 });
    const restarted = reduceAll([end('loop', 'success'), start('loop')], view);
    expect(restarted.steps.loop.loop).toBeUndefined();
  });

  it('records skipped blocks that never started', () => {
    const view = reduceAll([runStart, end('e1', 'skipped')]);
    expect(view.steps.e1).toEqual({
      status: 'skipped',
      executions: 0,
      logs: [],
      output: { status: 'skipped', durationMs: 5 },
      durationMs: 5,
    });
  });

  it('sums agent usage live and takes the final usage from run-end', () => {
    let view = reduceAll([
      runStart,
      start('a'),
      end('a', 'success', { text: 'x', usage: { inputTokens: 10, outputTokens: 2 } }),
      start('b'),
      end('b', 'success', { text: 'y', usage: { inputTokens: 5, outputTokens: 1 } }),
      start('c'),
      end('c', 'success', { usage: 'not usage' }),
    ]);
    expect(view.usage).toEqual({ inputTokens: 15, outputTokens: 3 });
    view = reduceRunEvent(view, {
      type: 'run-end',
      runId: R,
      status: 'success',
      durationMs: 99,
      usage: { inputTokens: 16, outputTokens: 3 },
    });
    expect(view).toMatchObject({
      status: 'success',
      durationMs: 99,
      usage: { inputTokens: 16, outputTokens: 3 },
    });
  });

  it('finishes the run and marks blocks still running as cancelled', () => {
    const view = reduceAll([
      runStart,
      start('a'),
      {
        type: 'run-end',
        runId: R,
        status: 'failure',
        error: 'boom',
        durationMs: 3,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
    expect(view).toMatchObject({ status: 'failure', error: 'boom', durationMs: 3 });
    expect(view.activeStepId).toBeUndefined();
    expect(view.steps.a.status).toBe('cancelled');
  });

  it('ignores events of another run', () => {
    const view = reduceAll([runStart, start('a')]);
    expect(reduceRunEvent(view, { ...(start('b') as object), runId: 'other' } as RunEvent)).toBe(view);
  });

  it('builds a placeholder view when events arrive without run-start', () => {
    const view = reduceRunEvent(null, start('a', 42));
    expect(view).toMatchObject({
      runId: R,
      status: 'running',
      activeStepId: 'a',
      steps: { a: { status: 'running' } },
    });
    expect(reduceRunEvent(null, log('b', 'x'))).toMatchObject({
      steps: { b: { logs: [{ stream: 'stdout', text: 'x' }] } },
    });
  });

  it('never mutates its input', () => {
    const events: RunEvent[] = [
      runStart,
      start('loop'),
      { type: 'loop-iteration', runId: R, stepId: 'loop', iteration: 1, maxIterations: 2 },
      start('a'),
      log('a', 'one'),
      log('a', ' two\nthree\n'),
      end('a', 'failure', { usage: { inputTokens: 1, outputTokens: 1 } }, 'bad'),
      end('skip', 'skipped'),
      end('loop', 'failure'),
      {
        type: 'run-end',
        runId: R,
        status: 'failure',
        durationMs: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ];
    let view: RunView | null = null;
    for (const event of events) {
      const frozenView = deepFreeze(view);
      const next = reduceRunEvent(frozenView, deepFreeze(structuredClone(event)));
      expect(next).not.toBe(frozenView);
      view = next;
    }
    expect(view?.status).toBe('failure');
  });
});

describe('logs', () => {
  const logsOf = (...events: RunEvent[]) => reduceAll([runStart, start('a'), ...events]).steps.a;

  it('merges consecutive chunks of an unfinished line', () => {
    const step = logsOf(log('a', 'Hel'), log('a', 'lo'), log('a', ' world\nnext'), log('a', ' line\n'));
    expect(step.logs).toEqual([
      { stream: 'stdout', text: 'Hello world\n' },
      { stream: 'stdout', text: 'next line\n' },
    ]);
  });

  it('splits multi-line chunks into one entry per line', () => {
    expect(logsOf(log('a', 'a\nb\r\nc')).logs).toEqual([
      { stream: 'stdout', text: 'a\n' },
      { stream: 'stdout', text: 'b\r\n' },
      { stream: 'stdout', text: 'c' },
    ]);
  });

  it('joins a CRLF pair that arrives split across two chunks', () => {
    expect(logsOf(log('a', 'one\r'), log('a', '\ntwo\r\n')).logs).toEqual([
      { stream: 'stdout', text: 'one\r\n' },
      { stream: 'stdout', text: 'two\r\n' },
    ]);
  });

  it('does not merge different streams', () => {
    expect(logsOf(log('a', 'out'), log('a', 'err\n', 'stderr'), log('a', ' more\n')).logs).toEqual([
      { stream: 'stdout', text: 'out' },
      { stream: 'stderr', text: 'err\n' },
      { stream: 'stdout', text: ' more\n' },
    ]);
  });

  it('streams agent tokens into one entry', () => {
    expect(logsOf(log('a', 'I ', 'agent'), log('a', 'think', 'agent'), log('a', '.', 'agent')).logs).toEqual([
      { stream: 'agent', text: 'I think.' },
    ]);
  });

  it('ignores empty chunks', () => {
    const before = reduceAll([runStart, start('a')]);
    expect(reduceRunEvent(before, log('a', '')).steps.a.logs).toEqual([]);
  });

  it(`caps logs at ${MAX_LOG_LINES} lines, dropping the oldest`, () => {
    const lines = Array.from({ length: MAX_LOG_LINES + 5 }, (_, i) => `line ${i}\n`);
    let view = reduceAll([runStart, start('a'), log('a', lines.slice(0, 10).join(''))]);
    expect(view.steps.a.logsTruncated).toBeUndefined();
    view = reduceRunEvent(view, log('a', lines.slice(10).join('')));
    expect(view.steps.a.logs).toHaveLength(MAX_LOG_LINES);
    expect(view.steps.a.logs[0].text).toBe('line 5\n');
    expect(view.steps.a.logs.at(-1)?.text).toBe(`line ${MAX_LOG_LINES + 4}\n`);
    expect(view.steps.a.logsTruncated).toBe(true);
    const restarted = reduceRunEvent(view, start('a', 50));
    expect(restarted.steps.a.logs).toEqual([]);
    expect(restarted.steps.a.logsTruncated).toBeUndefined();
  });
});

describe('runRecordSummary', () => {
  it('summarizes a finished run', () => {
    const view = reduceAll([
      runStart,
      {
        type: 'run-end',
        runId: R,
        status: 'failure',
        error: 'x',
        durationMs: 7,
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ]);
    expect(runRecordSummary(view, 'file:///w/a.workflow.yaml')).toEqual({
      runId: R,
      workflowUri: 'file:///w/a.workflow.yaml',
      workflowName: 'Flow',
      status: 'failure',
      startedAt: 1,
      durationMs: 7,
      error: 'x',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('omits fields a running view does not have yet', () => {
    expect(runRecordSummary(reduceAll([runStart]), 'u')).toEqual({
      runId: R,
      workflowUri: 'u',
      workflowName: 'Flow',
      status: 'running',
      startedAt: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});

describe('engine + view', () => {
  it('reduces a full engine run into a consistent view', async () => {
    const host = new FakeHost()
      .console(
        'tests',
        { exitCode: 1, logs: [{ stream: 'stdout', text: 'FAIL\n' }] },
        { exitCode: 0, logs: [{ stream: 'stdout', text: 'PASS\n' }] },
      )
      .agent(
        'review',
        { json: { approved: false }, usage: { inputTokens: 3, outputTokens: 1 } },
        { json: { approved: true }, usage: { inputTokens: 3, outputTokens: 1 } },
      );
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 3,
          until: '${{ steps.review.json.approved }}',
          steps: [
            { id: 'tests', type: 'console', run: 'npm test', continueOnError: true },
            { id: 'review', type: 'agent', model: 'p/m', prompt: 'r' },
            {
              id: 'gate',
              type: 'if',
              condition: '${{ steps.review.json.approved }}',
              then: [{ id: 'done', type: 'console', run: 'ok' }],
            },
          ],
        },
      ]),
      { host },
    );
    const view = reduceAll(r.events);
    expect(view.status).toBe('success');
    expect(view.activeStepId).toBeUndefined();
    expect(view.usage).toEqual({ inputTokens: 6, outputTokens: 2 });
    expect(view.steps.l).toMatchObject({
      status: 'success',
      executions: 1,
      loop: { iteration: 2, maxIterations: 3 },
    });
    expect(view.steps.tests).toMatchObject({
      status: 'success',
      executions: 2,
      iteration: 2,
      logs: [{ stream: 'stdout', text: 'PASS\n' }],
    });
    expect(view.steps.done).toMatchObject({ status: 'success', executions: 1 });
    expect(runRecordSummary(view, 'u')).toMatchObject({
      status: 'success',
      usage: { inputTokens: 6, outputTokens: 2 },
    });
  });

  it('reduces a cancelled engine run into a view with nothing left running', async () => {
    const controller = new AbortController();
    const host = new FakeHost().console('long', (_req, io) => {
      io.log('stdout', 'step 1 of 3\n');
      setTimeout(() => controller.abort(), 5);
      return { hang: true };
    });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 2,
          steps: [{ id: 'long', type: 'console', run: 'build' }],
        },
        { id: 'after', type: 'console', run: 'never' },
      ]),
      { host, signal: controller.signal },
    );
    const view = reduceAll(r.events);
    expect(view.status).toBe('cancelled');
    expect(view.activeStepId).toBeUndefined();
    expect(view.steps.l).toMatchObject({ status: 'cancelled', loop: { iteration: 1, maxIterations: 2 } });
    expect(view.steps.long).toMatchObject({
      status: 'cancelled',
      detail: 'build',
      logs: [{ stream: 'stdout', text: 'step 1 of 3\n' }],
    });
    expect(view.steps.after).toBeUndefined();
  });
});
