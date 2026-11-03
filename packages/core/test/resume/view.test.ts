import { describe, expect, it } from 'vitest';
import type { RunEvent, StepOutput, StepStatus } from '../../src/engine/types';
import { createRunView, reduceRunEvent, runRecordSummary, runStoppedAt } from '../../src/run';
import type { RunView, StepRunView } from '../../src/run/types';
import { FakeHost } from '../fakes/fakeHost';
import { run, workflow } from '../engine/helpers';

const R = 'run-1';
const runStart: RunEvent = { type: 'run-start', runId: R, workflowName: 'Flow', startedAt: 1, inputs: {} };
const start = (stepId: string, at = 10): RunEvent => ({
  type: 'step-start',
  runId: R,
  stepId,
  stepType: 'agent',
  at,
});
const end = (
  stepId: string,
  status: StepStatus,
  output: Record<string, unknown> = {},
  reused = false,
): RunEvent => ({
  type: 'step-end',
  runId: R,
  stepId,
  status,
  output: { ...output, status, durationMs: reused ? 400 : 5 } as StepOutput,
  ...(status === 'failure' && { error: 'broke' }),
  durationMs: reused ? 0 : 5,
  at: 20,
  ...(reused && { reused: true }),
});
const runEnd = (status: 'success' | 'failure' | 'cancelled'): RunEvent => ({
  type: 'run-end',
  runId: R,
  status,
  durationMs: 99,
  usage: { inputTokens: 0, outputTokens: 0 },
});

function reduceAll(events: RunEvent[], initial: RunView | null = null): RunView {
  return events.reduce<RunView | null>((view, event) => reduceRunEvent(view, event), initial) as RunView;
}

describe('run-start in the run view', () => {
  it('copies the resume, simulation, context and hash fields', () => {
    const context = {
      env: ['HOME'],
      secrets: ['TOKEN'],
      workflow: { name: 'Flow', file: 'flow.workflow.yaml' },
      workspace: { root: '/ws' },
    };
    const view = reduceRunEvent(null, {
      ...runStart,
      resumedFrom: { runId: 'run-0', stepId: 'tests' },
      simulated: true,
      context,
      blockHashes: { tests: '00000000000abc' },
    });
    expect(view).toEqual({
      ...createRunView(R, 'Flow', 1),
      resumedFrom: { runId: 'run-0', stepId: 'tests' },
      simulated: true,
      context,
      blockHashes: { tests: '00000000000abc' },
    });
  });

  it('adds none of them when run-start has none', () => {
    expect(reduceRunEvent(null, runStart)).toEqual(createRunView(R, 'Flow', 1));
    expect(reduceRunEvent(null, { ...runStart, simulated: false })).not.toHaveProperty('simulated');
  });
});

describe('reused step-end in the run view', () => {
  const usage = { inputTokens: 900, outputTokens: 100 };

  it('sets status and output without metrics, usage or executions', () => {
    const view = reduceAll([runStart, end('plan', 'success', { text: 'P', usage, model: 'p/m' }, true)]);
    expect(view.steps.plan).toEqual({
      status: 'success',
      executions: 0,
      logs: [],
      output: { text: 'P', usage, model: 'p/m', status: 'success', durationMs: 400 },
      durationMs: 0,
      reused: true,
    });
    expect(view.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(view.activeStepId).toBeUndefined();
  });

  it('keeps the error of a reused failure', () => {
    const view = reduceAll([runStart, end('tests', 'failure', { exitCode: 1 }, true)]);
    expect(view.steps.tests).toMatchObject({ status: 'failure', error: 'broke', reused: true });
  });

  it('clears the mark when the block starts or ends in this run', () => {
    const reused = reduceAll([runStart, end('a', 'success', {}, true)]);
    const started = reduceAll([start('a')], reused);
    expect(started.steps.a).not.toHaveProperty('reused');
    expect(started.steps.a.executions).toBe(1);
    const finished = reduceAll([end('a', 'success')], started);
    expect(finished.steps.a).not.toHaveProperty('reused');
    expect(finished.steps.a.metrics).toEqual({ durationMs: 5, executions: 1 });
    const skipped = reduceAll([end('a', 'skipped')], reused);
    expect(skipped.steps.a).not.toHaveProperty('reused');
  });

  it('leaves reused blocks out of the block metrics', () => {
    const view = reduceAll([
      runStart,
      end('plan', 'success', { usage }, true),
      start('tests'),
      end('tests', 'success'),
      runEnd('success'),
    ]);
    expect(Object.keys(runRecordSummary(view, 'u').blocks ?? {})).toEqual(['tests']);
  });
});

describe('runRecordSummary for resumed and simulated runs', () => {
  it('copies resumedFrom and simulated', () => {
    const view = reduceAll([
      { ...runStart, resumedFrom: { runId: 'run-0', stepId: 'tests' }, simulated: true },
      runEnd('success'),
    ]);
    const summary = runRecordSummary(view, 'u');
    expect(summary.resumedFrom).toEqual({ runId: 'run-0', stepId: 'tests' });
    expect(summary.simulated).toBe(true);
    expect(summary).not.toHaveProperty('stoppedAt');
  });

  it('names the block a failed run stopped at', () => {
    const view = reduceAll([
      runStart,
      end('old', 'failure', {}, true),
      start('lint', 10),
      end('lint', 'failure'),
      start('tests', 30),
      end('tests', 'failure'),
      runEnd('failure'),
    ]);
    expect(runRecordSummary(view, 'u').stoppedAt).toBe('tests');
  });

  it('names the innermost cancelled block of a cancelled run', () => {
    const view = reduceAll([runStart, start('loop', 10), start('fix', 20), runEnd('cancelled')]);
    expect(runRecordSummary(view, 'u').stoppedAt).toBe('fix');
  });

  it('leaves stoppedAt out of successful runs and runs without a failed block', () => {
    const passed = reduceAll([runStart, start('a'), end('a', 'failure'), runEnd('success')]);
    expect(runRecordSummary(passed, 'u')).not.toHaveProperty('stoppedAt');
    const badInputs = reduceAll([runStart, end('old', 'failure', {}, true), runEnd('failure')]);
    expect(runRecordSummary(badInputs, 'u')).not.toHaveProperty('stoppedAt');
  });
});

describe('runStoppedAt', () => {
  const view = (steps: Record<string, Partial<StepRunView>>): RunView => ({
    ...createRunView(R, 'Flow', 1),
    steps: Object.fromEntries(
      Object.entries(steps).map(([id, step]) => [
        id,
        { status: 'success', executions: 1, logs: [], ...step },
      ]),
    ),
  });

  it('picks the failed or cancelled block that started last', () => {
    expect(
      runStoppedAt(
        view({
          a: { status: 'failure', startedAt: 50 },
          b: { status: 'cancelled', startedAt: 70 },
          c: { status: 'success', startedAt: 90 },
          d: { status: 'failure', startedAt: 60 },
        }),
      ),
    ).toBe('b');
  });

  it('prefers the later block on equal start times and skips reused blocks', () => {
    expect(
      runStoppedAt(
        view({
          a: { status: 'failure', startedAt: 50 },
          b: { status: 'failure', startedAt: 50 },
          c: { status: 'failure', reused: true, startedAt: 99 },
        }),
      ),
    ).toBe('b');
  });

  it('counts failed blocks without a start time as the earliest', () => {
    expect(runStoppedAt(view({ a: { status: 'failure' }, b: { status: 'failure', startedAt: 5 } }))).toBe(
      'b',
    );
    expect(runStoppedAt(view({ a: { status: 'failure' } }))).toBe('a');
  });

  it('returns undefined when no block failed', () => {
    expect(runStoppedAt(view({ a: { status: 'success' }, b: { status: 'skipped' } }))).toBeUndefined();
  });

  it('names the failing block of a real run after continueOnError failures', async () => {
    const host = new FakeHost().console('lint', { exitCode: 1 }).console('tests', { exitCode: 1 });
    const r = await run(
      workflow([
        { id: 'lint', type: 'console', run: 'lint', continueOnError: true },
        { id: 'tests', type: 'console', run: 'tests' },
        { id: 'deploy', type: 'console', run: 'deploy' },
      ]),
      { host },
    );
    const runView = reduceAll(r.events);
    expect(runRecordSummary(runView, 'u').stoppedAt).toBe('tests');
  });
});

describe('a resumed engine run in the run view', () => {
  it('marks reused blocks and keeps their usage out of the run', async () => {
    const r = await run(
      workflow([
        { id: 'plan', type: 'agent', model: 'p/m', prompt: 'plan' },
        { id: 'tests', type: 'console', run: 'tests' },
      ]),
      {
        resume: {
          fromRunId: 'run-0',
          stepId: 'tests',
          outputs: { plan: { status: 'success', text: 'P', usage: { inputTokens: 5, outputTokens: 5 } } },
          loopIterations: {},
          blockHashes: { plan: '0000000000beef', tests: '0000000000cafe' },
        },
      },
    );
    const runView = reduceAll(r.events);
    expect(runView.steps.plan).toMatchObject({ status: 'success', reused: true, executions: 0 });
    expect(runView.steps.tests).not.toHaveProperty('reused');
    expect(runView.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(runView.resumedFrom).toEqual({ runId: 'run-0', stepId: 'tests' });
    // The reused block keeps the hash of the YAML its output came from; the target gets its current one.
    expect(runView.blockHashes?.plan).toBe('0000000000beef');
    expect(runView.blockHashes?.tests).toMatch(/^[0-9a-f]{14}$/);
    expect(runView.blockHashes?.tests).not.toBe('0000000000cafe');
    expect(runView.context?.workspace.root).toBe('/ws');
    const summary = runRecordSummary(runView, 'u');
    expect(summary.resumedFrom).toEqual({ runId: 'run-0', stepId: 'tests' });
    expect(Object.keys(summary.blocks ?? {})).toEqual(['tests']);
  });
});
