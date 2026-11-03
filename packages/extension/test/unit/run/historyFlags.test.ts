import { describe, expect, it } from 'vitest';
import { createRunView, type RunView, type StepRunView } from '@isar-flow/core';
import { createRunHistory, trimRunView } from '../../../src/run/history';
import { FakeMemento, memoryStore } from './fakes';

const A = 'file:///ws/a.workflow.yaml';

/** Run from here, test mode and live values fields that every trim level keeps. */
const MARKERS: Partial<RunView> = {
  resumedFrom: { runId: 'run-source', stepId: 'tests' },
  simulated: true,
  context: {
    env: ['HOME', 'PATH'],
    secrets: ['TOKEN'],
    workflow: { name: 'Workflow', file: '/ws/a.workflow.yaml' },
    workspace: { root: '/ws' },
  },
  blockHashes: { build: '00000000abcdef', tests: '0123456789abcd' },
};

function view(steps: RunView['steps'], extra: Partial<RunView> = {}): RunView {
  return { ...createRunView('r', 'Workflow', 1), status: 'success', durationMs: 5, steps, ...extra };
}

function step(output: StepRunView['output'], extra: Partial<StepRunView> = {}): StepRunView {
  return { status: 'success', executions: 1, logs: [], output, ...extra };
}

/** Steps big enough that only the skeleton fits into the history. */
function hugeSteps(extra: Partial<StepRunView> = {}): RunView['steps'] {
  const steps: RunView['steps'] = {};
  for (let i = 0; i < 6000; i++) {
    const output = {
      status: 'success' as const,
      ...Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`k${k}`, 'v'.repeat(150)])),
    };
    steps[`s${i}`] = step(output, extra);
  }
  return steps;
}

describe('trimRunView flags', () => {
  it('marks outputs whose strings were cut', () => {
    const big = 'x'.repeat(150_000);
    const trimmed = trimRunView(
      view({
        cut: step({ status: 'success', stdout: big }),
        nested: step({ status: 'success', json: { list: [{ deep: big }] } }),
        small: step({ status: 'success', stdout: 'ok' }),
        logsOnly: { ...step({ status: 'success' }), logs: [{ stream: 'stdout', text: big }] },
      }),
    );
    expect(trimmed.steps.cut.outputTrimmed).toBe(true);
    expect(trimmed.steps.nested.outputTrimmed).toBe(true);
    expect(trimmed.steps.small.outputTrimmed).toBeUndefined();
    // Cut logs don't change what later blocks read.
    expect(trimmed.steps.logsOnly.outputTrimmed).toBeUndefined();
  });

  it('keeps an earlier outputTrimmed mark and the reused flag', () => {
    const big = 'x'.repeat(150_000);
    const trimmed = trimRunView(
      view({
        earlier: step({ status: 'success', stdout: 'short now' }, { outputTrimmed: true, reused: true }),
        cut: step({ status: 'success', stdout: big }, { reused: true }),
      }),
    );
    expect(trimmed.steps.earlier).toMatchObject({ outputTrimmed: true, reused: true });
    expect(trimmed.steps.cut).toMatchObject({ outputTrimmed: true, reused: true });
  });

  it('keeps the run markers at every trim level', () => {
    const big = 'x'.repeat(150_000);
    const light = trimRunView(view({ s: step({ status: 'success', stdout: big }) }, MARKERS));
    expect(light).toMatchObject(MARKERS);
    const skeleton = trimRunView(view(hugeSteps(), MARKERS));
    expect(skeleton.steps.s0.output).toBeUndefined();
    expect(skeleton).toMatchObject(MARKERS);
  });

  it('keeps reused, loop positions and start times in the skeleton and marks dropped outputs', () => {
    const steps = hugeSteps({
      reused: true,
      startedAt: 42,
      iteration: 2,
      loop: { iteration: 3, maxIterations: 5 },
    });
    steps.noOutput = { status: 'skipped', executions: 0, logs: [] };
    const skeleton = trimRunView(view(steps));
    expect(skeleton.steps.s0).toEqual({
      status: 'success',
      executions: 1,
      startedAt: 42,
      iteration: 2,
      loop: { iteration: 3, maxIterations: 5 },
      reused: true,
      outputTrimmed: true,
      logs: [],
    });
    expect(skeleton.steps.noOutput).toEqual({ status: 'skipped', executions: 0, logs: [] });
  });
});

describe('run history with run markers', () => {
  it('saves and reloads the markers of resumed and simulated runs', async () => {
    const store = memoryStore();
    const memento = new FakeMemento();
    const history = createRunHistory(store, memento, () => 50);
    await history.save(view({ s: step({ status: 'success' }, { reused: true }) }, MARKERS), A);

    const reopened = createRunHistory(store, memento, () => 50);
    const saved = await reopened.getAsync('r');
    expect(saved).toMatchObject(MARKERS);
    expect(saved?.steps.s.reused).toBe(true);
  });
});
