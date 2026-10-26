import { describe, expect, it } from 'vitest';
import type { Step } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, run, workflow } from './helpers';

const body = (id = 'work'): Step => ({
  id,
  type: 'console',
  run: 'iteration ${{ loop.iteration }} index ${{ loop.index }}',
});

describe('until loops', () => {
  it('checks the condition after each iteration and exits with exitReason condition', async () => {
    const host = new FakeHost().console('work', { exitCode: 1 }, { exitCode: 1 }, { exitCode: 0 });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          until: '${{ steps.work.exitCode == 0 }}',
          maxIterations: 5,
          steps: [{ ...body(), continueOnError: true }],
        },
      ]),
      { host },
    );
    expect(host.consoleCalls.map((c) => c.command)).toEqual([
      'iteration 1 index 0',
      'iteration 2 index 1',
      'iteration 3 index 2',
    ]);
    expect(r.output('l')).toEqual({
      iterations: 3,
      exitReason: 'condition',
      status: 'success',
      durationMs: expect.any(Number),
    });
    expect(r.summary.status).toBe('success');
  });

  it('runs the body at least once even when the condition is already true', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([{ id: 'l', type: 'loop', until: 'true', maxIterations: 5, steps: [body()] }]),
      { host },
    );
    expect(host.consoleCalls).toHaveLength(1);
    expect(r.output('l')).toMatchObject({ iterations: 1, exitReason: 'condition' });
  });

  it('sees loop.iteration of the finished iteration in the condition', async () => {
    const r = await run(
      workflow([
        { id: 'l', type: 'loop', until: '${{ loop.iteration >= 2 }}', maxIterations: 5, steps: [body()] },
      ]),
    );
    expect(r.output('l')).toMatchObject({ iterations: 2, exitReason: 'condition' });
  });

  it('emits loop-iteration events with the limit', async () => {
    const r = await run(
      workflow([
        { id: 'l', type: 'loop', until: '${{ loop.iteration == 2 }}', maxIterations: 4, steps: [body()] },
      ]),
    );
    expect(eventsOfType(r.events, 'loop-iteration')).toEqual([
      { type: 'loop-iteration', runId: 'run-1', stepId: 'l', iteration: 1, maxIterations: 4 },
      { type: 'loop-iteration', runId: 'run-1', stepId: 'l', iteration: 2, maxIterations: 4 },
    ]);
    expect(r.trace).toEqual([
      'run-start',
      'start:l',
      'iter:l:1',
      'start:work',
      'end:work:success',
      'iter:l:2',
      'start:work',
      'end:work:success',
      'end:l:success',
      'run:success',
    ]);
  });
});

describe('while loops', () => {
  it('checks the condition before each iteration and may run zero times', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([{ id: 'l', type: 'loop', while: 'false', maxIterations: 5, steps: [body()] }]),
      {
        host,
      },
    );
    expect(host.consoleCalls).toHaveLength(0);
    expect(r.output('l')).toMatchObject({ iterations: 0, exitReason: 'condition', status: 'success' });
    expect(eventsOfType(r.events, 'loop-iteration')).toHaveLength(0);
  });

  it('sees the upcoming iteration in the condition', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        { id: 'l', type: 'loop', while: '${{ loop.iteration <= 3 }}', maxIterations: 10, steps: [body()] },
      ]),
      { host },
    );
    expect(host.consoleCalls).toHaveLength(3);
    expect(r.output('l')).toMatchObject({ iterations: 3, exitReason: 'condition' });
  });

  it('differs from until in ordering: the until body runs before its first check', async () => {
    const order: string[] = [];
    const host = new FakeHost().console('work', (req) => {
      order.push(req.command);
      return { stdout: 'done' };
    });
    // Both conditions look at the body's output, which does not exist before the first iteration.
    const untilRun = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          until: "${{ steps.work.stdout == 'done' }}",
          maxIterations: 3,
          steps: [body()],
        },
      ]),
      { host },
    );
    const whileRun = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          while: "${{ steps.work.stdout == 'done' }}",
          maxIterations: 3,
          steps: [body()],
        },
      ]),
      { host: new FakeHost() },
    );
    expect(untilRun.output('l')).toMatchObject({ iterations: 1, exitReason: 'condition' });
    expect(whileRun.output('l')).toMatchObject({ iterations: 0, exitReason: 'condition' });
    expect(order).toEqual(['iteration 1 index 0']);
  });

  it('ends with exitReason condition when the condition turns false right after the last allowed iteration', async () => {
    const r = await run(
      workflow([
        { id: 'l', type: 'loop', while: '${{ loop.iteration <= 2 }}', maxIterations: 2, steps: [body()] },
      ]),
    );
    expect(r.output('l')).toMatchObject({ iterations: 2, exitReason: 'condition', status: 'success' });
  });

  it('succeeds at the limit with onMaxIterations: continue', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          while: 'true',
          maxIterations: 2,
          onMaxIterations: 'continue',
          steps: [body()],
        },
        { id: 'after', type: 'console', run: 'after' },
      ]),
      { host },
    );
    expect(host.consoleCalls).toHaveLength(3);
    expect(r.output('l')).toMatchObject({ iterations: 2, exitReason: 'maxIterations', status: 'success' });
    expect(r.summary.status).toBe('success');
  });

  it('applies the limit when the condition still holds after maxIterations', async () => {
    const r = await run(
      workflow([{ id: 'l', type: 'loop', while: 'true', maxIterations: 2, steps: [body()] }]),
    );
    expect(r.output('l')).toMatchObject({ iterations: 2, exitReason: 'maxIterations', status: 'failure' });
  });
});

describe('maxIterations', () => {
  it('fails the loop and the run by default', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        { id: 'l', type: 'loop', until: 'false', maxIterations: 3, steps: [body()] },
        { id: 'after', type: 'console', run: 'never' },
      ]),
      { host },
    );
    expect(host.consoleCalls).toHaveLength(3);
    expect(r.error('l')).toBe("Loop 'l' reached its limit of 3 iterations without meeting its condition");
    expect(r.output('l')).toMatchObject({ iterations: 3, exitReason: 'maxIterations', status: 'failure' });
    expect(r.summary).toMatchObject({
      status: 'failure',
      error: "Loop 'l' reached its limit of 3 iterations without meeting its condition",
    });
  });

  it('continues with onMaxIterations: continue', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          until: 'false',
          maxIterations: 2,
          onMaxIterations: 'continue',
          steps: [body()],
        },
        { id: 'after', type: 'console', run: '${{ steps.l.exitReason }} ${{ steps.l.iterations }}' },
      ]),
      { host },
    );
    expect(r.output('l')).toMatchObject({ iterations: 2, exitReason: 'maxIterations', status: 'success' });
    expect(host.consoleCalls.at(-1)?.command).toBe('maxIterations 2');
    expect(r.summary.status).toBe('success');
  });

  it('repeats a loop without condition exactly maxIterations times and succeeds', async () => {
    const host = new FakeHost();
    const r = await run(workflow([{ id: 'l', type: 'loop', maxIterations: 4, steps: [body()] }]), { host });
    expect(host.consoleCalls).toHaveLength(4);
    expect(r.output('l')).toMatchObject({ iterations: 4, exitReason: 'maxIterations', status: 'success' });
  });

  it('falls back to a safe limit when maxIterations is invalid', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          until: 'false',
          maxIterations: Number.NaN,
          onMaxIterations: 'continue',
          steps: [body()],
        },
      ]),
      { host },
    );
    expect(host.consoleCalls).toHaveLength(5);
    expect(r.output('l')).toMatchObject({ iterations: 5 });
  });
});

describe('break', () => {
  it('exits only the innermost loop from inside an if', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        {
          id: 'outer',
          type: 'loop',
          maxIterations: 2,
          steps: [
            {
              id: 'inner',
              type: 'loop',
              maxIterations: 5,
              steps: [
                {
                  id: 'work',
                  type: 'console',
                  run: 'outer ${{ steps.outer_mark.stdout }} inner ${{ loop.iteration }}',
                },
                {
                  id: 'check',
                  type: 'if',
                  condition: '${{ loop.iteration == 2 }}',
                  then: [
                    { id: 'leave', type: 'break' },
                    { id: 'unreached', type: 'console', run: 'no' },
                  ],
                },
              ],
            },
            { id: 'outer_mark', type: 'console', run: 'mark' },
          ],
        },
      ]),
      { host },
    );
    expect(host.callOrder).toEqual(['work', 'work', 'outer_mark', 'work', 'work', 'outer_mark']);
    expect(r.output('inner')).toMatchObject({ iterations: 2, exitReason: 'break', status: 'success' });
    expect(r.output('outer')).toMatchObject({
      iterations: 2,
      exitReason: 'maxIterations',
      status: 'success',
    });
    expect(r.output('check')).toMatchObject({ branch: 'then', result: true, status: 'success' });
    expect(r.output('leave')).toMatchObject({ status: 'success' });
    expect(r.trace).not.toContain('start:unreached');
    expect(r.summary.status).toBe('success');
  });

  it('skips the until check when breaking', async () => {
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          until: '${{ nope( }}',
          maxIterations: 3,
          steps: [{ id: 'b', type: 'break' }],
        },
      ]),
    );
    expect(r.output('l')).toMatchObject({ iterations: 1, exitReason: 'break', status: 'success' });
  });

  it('fails outside of a loop', async () => {
    const r = await run(workflow([{ id: 'b', type: 'break' }]));
    expect(r.error('b')).toBe("Break block 'b' is not inside a loop. Move it into a loop or remove it.");
    expect(r.summary.status).toBe('failure');
  });
});

describe('loop bodies', () => {
  it('fails the loop and the run when a body block fails', async () => {
    const host = new FakeHost().console('work', { exitCode: 0 }, { exitCode: 3 });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          until: 'false',
          maxIterations: 5,
          steps: [body(), { id: 'next', type: 'console', run: 'n' }],
        },
        { id: 'after', type: 'console', run: 'never' },
      ]),
      { host },
    );
    expect(host.callOrder).toEqual(['work', 'next', 'work']);
    expect(r.output('l')).toMatchObject({ iterations: 2, status: 'failure' });
    expect(r.output('l')?.exitReason).toBeUndefined();
    expect(r.error('l')).toBe("Block 'work' failed: Command exited with code 3");
    expect(r.summary.error).toBe("Block 'work' failed: Command exited with code 3");
  });

  it('continues after the loop when the loop itself has continueOnError', async () => {
    const host = new FakeHost().console('work', { exitCode: 3 });
    const r = await run(
      workflow([
        { id: 'l', type: 'loop', maxIterations: 5, continueOnError: true, steps: [body()] },
        { id: 'after', type: 'console', run: 'runs' },
      ]),
      { host },
    );
    expect(host.callOrder).toEqual(['work', 'after']);
    expect(r.output('l')?.status).toBe('failure');
    expect(r.summary.status).toBe('success');
  });

  it('keeps the latest execution of body blocks in steps', async () => {
    const host = new FakeHost().console('work', { stdout: 'one' }, { stdout: 'two' });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 2,
          steps: [{ id: 'echo', type: 'console', run: 'prev=${{ steps.work.stdout }}' }, body()],
        },
        { id: 'after', type: 'console', run: 'last=${{ steps.work.stdout }}' },
      ]),
      { host },
    );
    expect(host.consoleCalls.map((c) => c.command)).toEqual([
      'prev=',
      'iteration 1 index 0',
      'prev=one',
      'iteration 2 index 1',
      'last=two',
    ]);
    expect(r.summary.steps.work.stdout).toBe('two');
  });

  it('makes steps.<id> follow the latest iteration, including a skip', async () => {
    const host = new FakeHost().console('fix', { stdout: 'fixed' });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 2,
          steps: [
            {
              id: 'gate',
              type: 'if',
              condition: '${{ loop.iteration == 1 }}',
              then: [{ id: 'fix', type: 'console', run: 'fix' }],
            },
            { id: 'seen', type: 'console', run: '${{ steps.fix.status }}:${{ steps.fix.stdout }}' },
          ],
        },
      ]),
      { host },
    );
    expect(host.consoleCalls.map((c) => c.command)).toEqual(['fix', 'success:fixed', 'skipped:']);
    expect(r.summary.steps.fix).toEqual({ status: 'skipped', durationMs: 0 });
  });

  it('gives nested loops their own loop variables and restores the outer ones', async () => {
    const host = new FakeHost();
    await run(
      workflow([
        {
          id: 'outer',
          type: 'loop',
          maxIterations: 2,
          steps: [
            {
              id: 'inner',
              type: 'loop',
              maxIterations: 2,
              steps: [{ id: 'i', type: 'console', run: 'in ${{ loop.iteration }}' }],
            },
            { id: 'o', type: 'console', run: 'out ${{ loop.iteration }}' },
          ],
        },
      ]),
      { host },
    );
    expect(host.consoleCalls.map((c) => c.command)).toEqual([
      'in 1',
      'in 2',
      'out 1',
      'in 1',
      'in 2',
      'out 2',
    ]);
  });

  it('reports expression errors in until and while', async () => {
    const r1 = await run(
      workflow([{ id: 'l', type: 'loop', until: '${{ ( }}', maxIterations: 2, steps: [body()] }]),
    );
    expect(r1.error('l')).toMatch(/^Expression error in until: /);
    const r2 = await run(
      workflow([{ id: 'l', type: 'loop', while: '${{ ( }}', maxIterations: 2, steps: [body()] }]),
    );
    expect(r2.error('l')).toMatch(/^Expression error in while: /);
    expect(r2.summary.error).toMatch(/^Block 'l' failed: Expression error in while: /);
  });

  it('supports structured conditions', async () => {
    const host = new FakeHost().console('work', { exitCode: 1 }, { exitCode: 0 });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          until: { value: '${{ steps.work.exitCode }}', op: 'eq', to: 0 },
          maxIterations: 5,
          steps: [{ ...body(), continueOnError: true }],
        },
      ]),
      { host },
    );
    expect(r.output('l')).toMatchObject({ iterations: 2, exitReason: 'condition' });
  });
});
