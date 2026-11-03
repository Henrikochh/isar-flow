import { describe, expect, it } from 'vitest';
import { LIVE_VALUE_MAX_CHARS, liveContext } from '../../src/live';
import { runView, stepView } from './helpers';

const long = (n: number, c = 'a') => c.repeat(n);

describe('liveContext', () => {
  it('copies the run fields, inputs and every block output', () => {
    const run = runView({
      simulated: true,
      status: 'failure',
      inputs: { task: 'login form', rounds: 2 },
      steps: {
        tests: stepView({ output: { status: 'success', exitCode: 0, output: 'ok' } }),
        fix: stepView({ status: 'skipped', output: { status: 'skipped', durationMs: 0 } }),
        review: stepView({ status: 'success', reused: true, output: { status: 'success', text: 'fine' } }),
        pending: stepView({ status: 'pending' }),
      },
      context: {
        env: ['HOME', 'PATH'],
        secrets: ['TOKEN'],
        workflow: { name: 'Review loop', file: '/ws/review.workflow.yaml' },
        workspace: { root: '/ws' },
      },
    });
    const context = liveContext(run);
    expect(context).toEqual({
      runId: 'run-1',
      startedAt: 1000,
      status: 'failure',
      simulated: true,
      inputs: { task: 'login form', rounds: 2 },
      steps: {
        tests: { status: 'success', exitCode: 0, output: 'ok' },
        fix: { status: 'skipped', durationMs: 0 },
        review: { status: 'success', text: 'fine' },
      },
      loops: {},
      env: ['HOME', 'PATH'],
      secrets: ['TOKEN'],
      workflow: { name: 'Review loop', file: '/ws/review.workflow.yaml' },
      workspace: { root: '/ws' },
    });
    expect(LIVE_VALUE_MAX_CHARS).toBe(2048);
  });

  it('deep-copies so later changes to the run do not leak in', () => {
    const output = { status: 'success' as const, json: { issues: ['a'] } };
    const run = runView({ inputs: { list: [1] }, steps: { review: stepView({ output }) } });
    const context = liveContext(run);
    output.json.issues.push('b');
    (run.inputs.list as number[]).push(2);
    expect(context.steps.review.json).toEqual({ issues: ['a'] });
    expect(context.inputs.list).toEqual([1]);
  });

  it('cuts strings longer than 2,048 characters, also nested ones', () => {
    const run = runView({
      inputs: { task: long(5000), short: long(LIVE_VALUE_MAX_CHARS) },
      steps: {
        tests: stepView({ output: { status: 'success', output: long(3000, 'x') } }),
        review: stepView({ output: { status: 'success', json: { issues: [long(2049, 'y')] } } }),
      },
    });
    const context = liveContext(run);
    expect(context.inputs.task).toBe(`${long(2048)}…`);
    expect(context.inputs.short).toBe(long(2048));
    expect(context.steps.tests.output).toBe(`${long(2048, 'x')}…`);
    expect((context.steps.review.json as { issues: string[] }).issues[0]).toBe(`${long(2048, 'y')}…`);
  });

  it('does not split a surrogate pair when cutting', () => {
    const text = `${long(2047)}😀${long(10)}`;
    const context = liveContext(runView({ inputs: { text } }));
    expect(context.inputs.text).toBe(`${long(2047)}…`);
  });

  it('takes the latest iteration of each loop', () => {
    const run = runView({
      steps: {
        outer: stepView({ loop: { iteration: 3, maxIterations: 5 }, output: { status: 'success' } }),
        inner: stepView({ status: 'running', loop: { iteration: 1, maxIterations: 2 } }),
      },
    });
    expect(liveContext(run).loops).toEqual({
      outer: { iteration: 3, index: 2 },
      inner: { iteration: 1, index: 0 },
    });
  });

  it('falls back for runs saved without a context', () => {
    const context = liveContext(runView({ workflowName: 'Old run' }));
    expect(context.env).toEqual([]);
    expect(context.secrets).toEqual([]);
    expect(context.workflow).toEqual({ name: 'Old run', file: '' });
    expect(context.workspace).toEqual({ root: '' });
    expect(context).not.toHaveProperty('simulated');
  });

  it('keeps a block id named __proto__ as a plain key', () => {
    const steps = JSON.parse(
      '{"__proto__": {"status": "success", "executions": 1, "logs": [], "output": {"status": "success"}}}',
    );
    const context = liveContext(runView({ steps }));
    expect(Object.hasOwn(context.steps, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(context.steps)).toBe(Object.prototype);
  });
});
