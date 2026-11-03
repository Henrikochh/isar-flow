import { describe, expect, it } from 'vitest';
import { reduceRunEvent, type RunEvent, type RunView, type StepStatus } from '@isar-flow/core';
import { buildCanvasModel } from '../../../src/views/workflow/canvas/model';
import {
  effectiveStatus,
  laneState,
  loopProgress,
  segmentState,
} from '../../../src/views/workflow/canvas/runOverlay';
import { reviewWorkflow } from './helpers';

const model = buildCanvasModel(reviewWorkflow());
const entry = (id: string) => model.byId.get(id)!;
const loopBody = entry('review_loop').children[0];

const runId = 'r1';
let at = 0;
const start = (stepId: string, iteration?: number): RunEvent => ({
  type: 'step-start',
  runId,
  stepId,
  stepType: entry(stepId).type!,
  ...(iteration !== undefined && { iteration }),
  at: ++at,
});
const end = (
  stepId: string,
  status: StepStatus = 'success',
  output: Record<string, unknown> = {},
): RunEvent => ({
  type: 'step-end',
  runId,
  stepId,
  status,
  output: { status, ...output },
  durationMs: 1,
  at: ++at,
});
const iteration = (n: number): RunEvent => ({
  type: 'loop-iteration',
  runId,
  stepId: 'review_loop',
  iteration: n,
  maxIterations: 5,
});

function view(events: RunEvent[]): RunView {
  const first: RunEvent = { type: 'run-start', runId, workflowName: 'w', startedAt: 0, inputs: {} };
  return [first, ...events].reduce<RunView | null>((v, e) => reduceRunEvent(v, e), null)!;
}

const firstRound: RunEvent[] = [
  start('implement'),
  end('implement'),
  start('review_loop'),
  iteration(1),
  start('tests', 1),
  end('tests'),
  start('review', 1),
  end('review'),
  start('needs_fix', 1),
  start('fix', 1),
  end('fix'),
  end('needs_fix', 'success', { branch: 'then' }),
];

describe('run overlay in the middle of the second round', () => {
  const run = view([...firstRound, iteration(2), start('tests', 2), end('tests'), start('review', 2)]);

  it('treats blocks from the previous round as not reached yet', () => {
    expect(effectiveStatus(run, entry('tests'))).toBe('success');
    expect(effectiveStatus(run, entry('review'))).toBe('running');
    expect(effectiveStatus(run, entry('needs_fix'))).toBe('pending');
    expect(effectiveStatus(run, entry('fix'))).toBe('pending');
  });

  it('flows the current into the running block and dims what follows', () => {
    expect(segmentState(run, loopBody, 0, entry('review_loop'))).toBe('passed');
    expect(segmentState(run, loopBody, 1, entry('review_loop'))).toBe('current');
    expect(segmentState(run, loopBody, 2, entry('review_loop'))).toBe('pending');
    expect(segmentState(run, model.root, 1, null)).toBe('passed');
    expect(segmentState(run, model.root, 2, null)).toBe('pending');
    expect(laneState(run, entry('needs_fix'), 'then')).toBe('pending');
  });

  it('reports the loop iteration', () => {
    expect(loopProgress(run, entry('review_loop'))).toEqual({
      running: true,
      iteration: 2,
      maxIterations: 5,
    });
  });

  it('is idle without a run', () => {
    expect(segmentState(null, model.root, 0, null)).toBe('idle');
    expect(effectiveStatus(null, entry('tests'))).toBeUndefined();
    expect(laneState(null, entry('needs_fix'), 'then')).toBe('idle');
  });
});

describe('run overlay after a finished run', () => {
  const run = view([
    ...firstRound,
    iteration(2),
    start('tests', 2),
    end('tests'),
    start('review', 2),
    end('review'),
    start('needs_fix', 2),
    end('fix', 'skipped'),
    end('needs_fix', 'success', { branch: 'else' }),
    end('review_loop', 'success', { iterations: 2 }),
    { type: 'run-end', runId, status: 'success', durationMs: 20, usage: { inputTokens: 0, outputTokens: 0 } },
  ]);

  it('marks the taken and untaken lanes', () => {
    expect(laneState(run, entry('needs_fix'), 'else')).toBe('passed');
    expect(laneState(run, entry('needs_fix'), 'then')).toBe('untaken');
    expect(effectiveStatus(run, entry('fix'))).toBe('skipped');
  });

  it('lets the current reach the end', () => {
    expect(segmentState(run, model.root, 2, null)).toBe('passed');
    expect(loopProgress(run, entry('review_loop'))).toEqual({
      running: false,
      iteration: 2,
      maxIterations: 5,
    });
  });
});

describe('skipped blocks inside a running loop', () => {
  it('count for the round in which their If decided', () => {
    const run = view([
      ...firstRound,
      iteration(2),
      start('tests', 2),
      end('tests'),
      start('review', 2),
      end('review'),
      start('needs_fix', 2),
      end('fix', 'skipped'),
    ]);
    expect(effectiveStatus(run, entry('fix'))).toBe('skipped');
    expect(segmentState(run, entry('needs_fix').children[0], 0, entry('needs_fix'))).toBe('pending');
  });
});

describe('reused blocks of a resumed run', () => {
  const resumed = (reused: boolean): RunView => ({
    runId: 'r2',
    workflowName: 'w',
    status: 'running',
    startedAt: 0,
    inputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    activeStepId: 'review',
    resumedFrom: { runId: 'r1', stepId: 'review' },
    steps: {
      implement: { status: 'success', executions: 0, durationMs: 0, logs: [], reused: true },
      review_loop: { status: 'running', executions: 1, loop: { iteration: 3, maxIterations: 5 }, logs: [] },
      tests: { status: 'failure', executions: 0, durationMs: 0, logs: [], reused },
      review: { status: 'running', executions: 1, iteration: 3, logs: [] },
    },
  });

  it('counts a reused block in the loop the run continues as current', () => {
    expect(effectiveStatus(resumed(true), entry('tests'))).toBe('failure');
    expect(effectiveStatus(resumed(true), entry('implement'))).toBe('success');
    expect(effectiveStatus(resumed(false), entry('tests'))).toBe('pending');
  });
});
