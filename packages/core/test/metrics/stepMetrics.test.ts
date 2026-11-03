import { describe, expect, it } from 'vitest';
import type { RunEvent, StepOutput, StepStatus } from '../../src/engine/types';
import { reduceRunEvent } from '../../src/run';
import type { RunView } from '../../src/run/types';
import { FakeHost } from '../fakes/fakeHost';
import { AgentRunError } from '../../src/engine';
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
  durationMs: number,
  output: Record<string, unknown> = {},
): RunEvent => ({
  type: 'step-end',
  runId: R,
  stepId,
  status,
  output: { ...output, status, durationMs } as StepOutput,
  durationMs,
  at: 20,
});
const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

function reduceAll(events: RunEvent[], initial: RunView | null = null): RunView {
  return events.reduce<RunView | null>((view, event) => reduceRunEvent(view, event), initial) as RunView;
}

describe('step metrics', () => {
  it('records time and executions of a console block', () => {
    const view = reduceAll([runStart, start('tests'), end('tests', 'success', 1200, { exitCode: 0 })]);
    expect(view.steps.tests.metrics).toEqual({ durationMs: 1200, executions: 1 });
  });

  it('records tokens, model, turns and tool calls of an agent block', () => {
    const view = reduceAll([
      runStart,
      start('fix'),
      end('fix', 'success', 3000, {
        text: 'done',
        model: 'litellm/claude',
        usage: usage(1200, 300),
        turns: 4,
        toolCalls: 6,
      }),
    ]);
    expect(view.steps.fix.metrics).toEqual({
      durationMs: 3000,
      executions: 1,
      usage: usage(1200, 300),
      model: 'litellm/claude',
      turns: 4,
      toolCalls: 6,
    });
  });

  it('sums every execution of a block that a loop runs again and keeps the latest model', () => {
    const view = reduceAll([
      runStart,
      start('fix', 10),
      end('fix', 'success', 100, { model: 'p/a', usage: usage(10, 1), turns: 2, toolCalls: 3 }),
      start('fix', 200),
      end('fix', 'failure', 50, { model: 'p/b', usage: usage(5, 2), turns: 1, toolCalls: 0 }),
      start('fix', 300),
    ]);
    expect(view.steps.fix.status).toBe('running');
    expect(view.steps.fix.metrics).toEqual({
      durationMs: 150,
      executions: 2,
      usage: usage(15, 3),
      model: 'p/b',
      turns: 3,
      toolCalls: 3,
    });
  });

  it('sets loop iterations from the latest execution of the loop', () => {
    const view = reduceAll([
      runStart,
      start('loop'),
      end('loop', 'success', 900, { iterations: 3, exitReason: 'condition' }),
      start('loop'),
      end('loop', 'success', 400, { iterations: 1, exitReason: 'condition' }),
    ]);
    expect(view.steps.loop.metrics).toEqual({ durationMs: 1300, executions: 2, iterations: 1 });
  });

  it('gives skipped blocks no metrics and keeps earlier ones when a later execution is skipped', () => {
    let view = reduceAll([runStart, end('other', 'skipped', 0)]);
    expect(view.steps.other.metrics).toBeUndefined();
    view = reduceAll([start('fix'), end('fix', 'success', 70), end('fix', 'skipped', 0)], view);
    expect(view.steps.fix).toMatchObject({ status: 'skipped', metrics: { durationMs: 70, executions: 1 } });
  });

  it('counts failed agent blocks that used tokens', () => {
    const view = reduceAll([
      runStart,
      start('fix'),
      end('fix', 'failure', 40, { usage: usage(30, 5), error: 'The agent used all 2 turns' }),
    ]);
    expect(view.steps.fix.metrics).toEqual({ durationMs: 40, executions: 1, usage: usage(30, 5) });
  });

  it('counts a cancelled execution that ended, but not a block the run left running', () => {
    const view = reduceAll([
      runStart,
      start('a'),
      end('a', 'cancelled', 15),
      start('b'),
      { type: 'run-end', runId: R, status: 'cancelled', durationMs: 30, usage: usage(0, 0) },
    ]);
    expect(view.steps.a.metrics).toEqual({ durationMs: 15, executions: 1 });
    expect(view.steps.b.status).toBe('cancelled');
    expect(view.steps.b.metrics).toBeUndefined();
  });

  it('ignores malformed outputs', () => {
    const view = reduceAll([
      runStart,
      start('a'),
      end('a', 'success', 10, {
        usage: { inputTokens: '5', outputTokens: 1 },
        model: 42,
        turns: Number.NaN,
        toolCalls: -1,
        iterations: 'three',
      }),
      start('a'),
      end('a', 'success', 10, { usage: usage(Number.POSITIVE_INFINITY, 1), model: '', turns: '2' }),
    ]);
    expect(view.steps.a.metrics).toEqual({ durationMs: 20, executions: 2 });
  });

  it('ignores a malformed duration but still counts the execution', () => {
    const event = end('a', 'success', 10) as Extract<RunEvent, { type: 'step-end' }>;
    const view = reduceAll([runStart, start('a'), { ...event, durationMs: Number.NaN }]);
    expect(view.steps.a.metrics).toEqual({ durationMs: 0, executions: 1 });
  });

  it('reduces old views without metrics', () => {
    const old = reduceAll([runStart, start('a'), end('a', 'success', 10)]);
    const { metrics: _metrics, ...stepWithout } = old.steps.a;
    const view = reduceAll([start('a'), end('a', 'success', 5)], { ...old, steps: { a: stepWithout } });
    expect(view.steps.a.metrics).toEqual({ durationMs: 5, executions: 1 });
  });
});

describe('step metrics from engine runs', () => {
  it('counts retries as one execution with the tokens of every attempt', async () => {
    const host = new FakeHost().agent(
      'a',
      { error: new AgentRunError('bad JSON', usage(10, 2)) },
      { usage: usage(5, 1), turns: 2, toolCalls: 1, model: 'p/fallback' },
    );
    const r = await run(
      workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x', retry: { max: 1 } }]),
      { host },
    );
    const view = reduceAll(r.events);
    expect(view.steps.a.metrics).toEqual({
      durationMs: expect.any(Number),
      executions: 1,
      usage: usage(15, 3),
      model: 'p/fallback',
      turns: 2,
      toolCalls: 1,
    });
    expect(view.usage).toEqual(usage(15, 3));
  });

  it('counts the executions of blocks inside loops and the loop iterations', async () => {
    const host = new FakeHost()
      .console('tests', { exitCode: 1 }, { exitCode: 1 }, { exitCode: 0 })
      .agent('fix', { usage: usage(100, 20), toolCalls: 2 });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 5,
          until: '${{ steps.tests.exitCode == 0 }}',
          steps: [
            { id: 'tests', type: 'console', run: 'npm test', continueOnError: true },
            {
              id: 'gate',
              type: 'if',
              condition: '${{ steps.tests.exitCode != 0 }}',
              then: [{ id: 'fix', type: 'agent', model: 'p/m', prompt: 'fix' }],
            },
          ],
        },
      ]),
      { host },
    );
    const view = reduceAll(r.events);
    expect(view.steps.l.metrics).toMatchObject({ executions: 1, iterations: 3 });
    expect(view.steps.tests.metrics).toMatchObject({ executions: 3 });
    expect(view.steps.fix).toMatchObject({
      status: 'skipped',
      metrics: { executions: 2, usage: usage(200, 40), toolCalls: 4, turns: 2 },
    });
  });
});
