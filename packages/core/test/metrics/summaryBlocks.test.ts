import { describe, expect, it } from 'vitest';
import type { RunEvent, StepOutput, StepStatus } from '../../src/engine/types';
import { reduceRunEvent, runRecordSummary } from '../../src/run';
import type { RunView } from '../../src/run/types';
import { FakeHost } from '../fakes/fakeHost';
import { run, workflow } from '../engine/helpers';

const R = 'run-1';
const runStart: RunEvent = { type: 'run-start', runId: R, workflowName: 'Flow', startedAt: 1, inputs: {} };
const start = (stepId: string): RunEvent => ({
  type: 'step-start',
  runId: R,
  stepId,
  stepType: 'agent',
  at: 1,
});
const end = (
  stepId: string,
  status: StepStatus,
  durationMs: number,
  output: Record<string, unknown> = {},
): RunEvent => ({
  type: 'step-end',
  runId: R,
  stepId,
  status,
  output: { ...output, status, durationMs } as StepOutput,
  durationMs,
  at: 2,
});
const runEnd: RunEvent = {
  type: 'run-end',
  runId: R,
  status: 'success',
  durationMs: 99,
  usage: { inputTokens: 0, outputTokens: 0 },
};

function reduceAll(events: RunEvent[]): RunView {
  return events.reduce<RunView | null>((view, event) => reduceRunEvent(view, event), null) as RunView;
}

describe('runRecordSummary blocks', () => {
  it('lists compact numbers for every block with metrics', () => {
    const view = reduceAll([
      runStart,
      start('plan'),
      end('plan', 'success', 2000, {
        text: 'a long answer that must not be copied',
        model: 'litellm/claude',
        usage: { inputTokens: 1000, outputTokens: 200 },
        turns: 3,
        toolCalls: 5,
      }),
      start('tests'),
      end('tests', 'failure', 800, { exitCode: 1, output: 'FAIL', stdout: 'FAIL' }),
      end('skipped', 'skipped', 0),
      runEnd,
    ]);
    const summary = runRecordSummary(view, 'u');
    expect(summary.blocks).toEqual({
      plan: {
        status: 'success',
        durationMs: 2000,
        inputTokens: 1000,
        outputTokens: 200,
        model: 'litellm/claude',
      },
      tests: { status: 'failure', durationMs: 800 },
    });
    expect(JSON.stringify(summary)).not.toContain('long answer');
    expect(JSON.stringify(summary)).not.toContain('FAIL');
  });

  it('reports loop iterations for loops and executions for blocks that ran more than once', () => {
    const view = reduceAll([
      runStart,
      start('loop'),
      start('fix'),
      end('fix', 'success', 10),
      start('fix'),
      end('fix', 'success', 20),
      end('loop', 'success', 40, { iterations: 2, exitReason: 'condition' }),
      start('once'),
      end('once', 'success', 5),
      runEnd,
    ]);
    expect(runRecordSummary(view, 'u').blocks).toEqual({
      loop: { status: 'success', durationMs: 40, iterations: 2 },
      fix: { status: 'success', durationMs: 30, iterations: 2 },
      once: { status: 'success', durationMs: 5 },
    });
  });

  it('omits blocks when no block has metrics', () => {
    const view = reduceAll([runStart, start('a'), end('b', 'skipped', 0)]);
    expect(runRecordSummary(view, 'u')).not.toHaveProperty('blocks');
  });

  it('summarizes a real engine run', async () => {
    const host = new FakeHost().agent('review', { usage: { inputTokens: 7, outputTokens: 3 }, model: 'p/m' });
    const r = await run(
      workflow([
        { id: 'tests', type: 'console', run: 'npm test' },
        { id: 'review', type: 'agent', model: 'p/m', prompt: 'r' },
      ]),
      { host },
    );
    const summary = runRecordSummary(reduceAll(r.events), 'u');
    expect(summary.blocks).toEqual({
      tests: { status: 'success', durationMs: expect.any(Number) },
      review: {
        status: 'success',
        durationMs: expect.any(Number),
        inputTokens: 7,
        outputTokens: 3,
        model: 'p/m',
      },
    });
  });
});
