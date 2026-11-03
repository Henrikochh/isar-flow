import { describe, expect, it } from 'vitest';
import type { ResumeOptions, StepOutput } from '../../src/engine/types';
import type { Step } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, run, workflow } from '../engine/helpers';

function resume(
  stepId: string,
  outputs: Record<string, StepOutput> = {},
  loopIterations: Record<string, number> = {},
): { resume: ResumeOptions } {
  return { resume: { fromRunId: 'run-0', stepId, outputs, loopIterations } };
}

const ok = (output: Record<string, unknown> = {}): StepOutput => ({
  status: 'success',
  durationMs: 40,
  ...output,
});

describe('resume at a top-level block', () => {
  const steps: Step[] = [
    { id: 'build', type: 'console', run: 'npm run build' },
    { id: 'plan', type: 'agent', model: 'p/m', prompt: 'Plan ${{ steps.build.output }}' },
    { id: 'tests', type: 'console', run: 'test ${{ steps.plan.text }} ${{ steps.build.exitCode }}' },
    { id: 'deploy', type: 'console', run: 'deploy' },
  ];
  const outputs = {
    build: ok({ exitCode: 0, output: 'built' }),
    plan: ok({ text: 'the plan', usage: { inputTokens: 500, outputTokens: 70 } }),
    tests: ok({ exitCode: 1 }),
    deploy: ok({ exitCode: 0 }),
  };

  it('reports earlier blocks as reused without running them and runs the rest', async () => {
    const r = await run(workflow(steps), resume('tests', outputs));
    expect(r.trace).toEqual([
      'run-start',
      'end:build:success',
      'end:plan:success',
      'start:tests',
      'end:tests:success',
      'start:deploy',
      'end:deploy:success',
      'run:success',
    ]);
    expect(r.host.callOrder).toEqual(['tests', 'deploy']);
    expect(eventsOfType(r.events, 'step-end')[0]).toEqual({
      type: 'step-end',
      runId: 'run-1',
      stepId: 'build',
      status: 'success',
      output: outputs.build,
      durationMs: 0,
      at: expect.any(Number),
      reused: true,
    });
    expect(eventsOfType(r.events, 'step-end')[2]).not.toHaveProperty('reused');
  });

  it("lets the target's templates read the reused outputs", async () => {
    const r = await run(workflow(steps), resume('tests', outputs));
    expect(r.host.consoleCalls[0].command).toBe('test the plan 0');
    expect(r.summary.steps.plan).toEqual(outputs.plan);
  });

  it('counts the usage of executed blocks only', async () => {
    const host = new FakeHost().agent('plan2', { usage: { inputTokens: 30, outputTokens: 10 } });
    const wf = workflow([...steps, { id: 'plan2', type: 'agent', model: 'p/m', prompt: 'again' }]);
    const r = await run(wf, { host, tokenBudget: 100, ...resume('tests', outputs) });
    expect(r.summary.status).toBe('success');
    expect(r.summary.usage).toEqual({ inputTokens: 30, outputTokens: 10 });
    expect(eventsOfType(r.events, 'run-end')[0].usage).toEqual({ inputTokens: 30, outputTokens: 10 });
  });

  it('runs everything when the target is the first block', async () => {
    const r = await run(workflow(steps), resume('build', outputs));
    expect(r.host.callOrder).toEqual(['build', 'plan', 'tests', 'deploy']);
    expect(eventsOfType(r.events, 'step-end').some((e) => e.reused)).toBe(false);
  });

  it('reports nothing for earlier blocks without a stored output', async () => {
    const r = await run(workflow(steps), resume('tests', { plan: outputs.plan }));
    expect(r.trace.slice(0, 3)).toEqual(['run-start', 'end:plan:success', 'start:tests']);
    expect(r.host.consoleCalls[0].command).toBe('test the plan ');
    expect(r.summary.steps).not.toHaveProperty('build');
  });

  it('ignores reused failures, stops and skipped blocks', async () => {
    const wf = workflow([
      { id: 'broken', type: 'console', run: 'x' },
      { id: 'skippedBefore', type: 'console', run: 'x' },
      { id: 'halt', type: 'stop', outcome: 'failure', message: 'halt' },
      { id: 'target', type: 'console', run: 'target ${{ steps.broken.status }}' },
    ]);
    const r = await run(
      wf,
      resume('target', {
        broken: { status: 'failure', exitCode: 2, error: 'Command exited with code 2' },
        skippedBefore: { status: 'skipped', durationMs: 0 },
        halt: { status: 'failure', error: 'halt' },
      }),
    );
    expect(r.trace).toEqual([
      'run-start',
      'end:broken:failure',
      'end:skippedBefore:skipped',
      'end:halt:failure',
      'start:target',
      'end:target:success',
      'run:success',
    ]);
    expect(r.error('broken')).toBe('Command exited with code 2');
    expect(r.host.consoleCalls[0].command).toBe('target failure');
  });

  it('reports a reused container and its blocks in document order', async () => {
    const wf = workflow([
      {
        id: 'retryLoop',
        type: 'loop',
        maxIterations: 3,
        steps: [
          { id: 'work', type: 'console', run: 'work' },
          { id: 'leave', type: 'break' },
        ],
      },
      { id: 'target', type: 'console', run: 'target' },
    ]);
    const r = await run(
      wf,
      resume('target', {
        retryLoop: ok({ iterations: 1, exitReason: 'break' }),
        work: ok({ exitCode: 0 }),
        leave: ok(),
      }),
    );
    expect(r.trace).toEqual([
      'run-start',
      'end:retryLoop:success',
      'end:work:success',
      'end:leave:success',
      'start:target',
      'end:target:success',
      'run:success',
    ]);
    expect(eventsOfType(r.events, 'loop-iteration')).toEqual([]);
  });

  it('never reuses blocks without an id and reports a duplicate id once', async () => {
    const noId = { type: 'console', run: 'no id' } as unknown as Step;
    const wf = workflow([
      noId,
      { id: 'twice', type: 'console', run: 'first' },
      { id: 'twice', type: 'console', run: 'second' },
      { id: 'target', type: 'console', run: 'target' },
    ]);
    const r = await run(wf, resume('target', { undefined: ok({ exitCode: 9 }), twice: ok({ exitCode: 0 }) }));
    expect(r.trace).toEqual([
      'run-start',
      'end:twice:success',
      'start:target',
      'end:target:success',
      'run:success',
    ]);
  });

  it('fails without running a block when the target is not in the workflow anymore', async () => {
    const r = await run(workflow(steps), resume('gone', outputs));
    expect(r.trace).toEqual(['run-start', 'run:failure']);
    expect(r.summary.error).toBe(
      "Block 'gone' isn't in the workflow anymore, so the run can't continue there. Run the whole workflow instead.",
    );
    expect(r.host.calls).toEqual([]);
  });

  it('retries the target like in a normal run', async () => {
    const host = new FakeHost().console('tests', { exitCode: 1 }, { exitCode: 0 });
    const wf = workflow(steps.map((s) => (s.id === 'tests' ? { ...s, retry: { max: 2 } } : s)));
    const r = await run(wf, { host, ...resume('tests', outputs) });
    expect(host.callOrder).toEqual(['tests', 'tests', 'deploy']);
    expect(r.summary.status).toBe('success');
  });

  it('starts agent sessions empty', async () => {
    const wf = workflow([
      { id: 'build', type: 'console', run: 'build' },
      { id: 'chat', type: 'agent', model: 'p/m', prompt: 'hi', session: 'continue' },
    ]);
    const r = await run(wf, resume('chat', { build: ok(), chat: ok({ text: 'earlier answer' }) }));
    expect(r.host.agentCalls[0].history).toEqual([]);
  });

  it('runs a target container normally', async () => {
    const wf = workflow([
      { id: 'build', type: 'console', run: 'build' },
      {
        id: 'gate',
        type: 'if',
        condition: '${{ steps.build.exitCode == 0 }}',
        then: [{ id: 'yes', type: 'console', run: 'yes' }],
        else: [{ id: 'no', type: 'console', run: 'no' }],
      },
      {
        id: 'again',
        type: 'loop',
        until: '${{ loop.iteration == 2 }}',
        maxIterations: 5,
        steps: [{ id: 'step', type: 'console', run: 'step ${{ loop.iteration }}' }],
      },
    ]);
    const gate = await run(wf, resume('gate', { build: ok({ exitCode: 3 }) }, { again: 4 }));
    expect(gate.output('gate')).toMatchObject({ branch: 'else', result: false });
    expect(gate.trace).toContain('end:yes:skipped');
    const loop = await run(wf, resume('again', { build: ok({ exitCode: 0 }) }, { again: 4 }));
    expect(eventsOfType(loop.events, 'loop-iteration').map((e) => e.iteration)).toEqual([1, 2]);
    expect(loop.host.consoleCalls.map((c) => c.command)).toEqual(['step 1', 'step 2']);
  });
});

describe('resume inside a loop', () => {
  const reviewLoop = (extra: Partial<Extract<Step, { type: 'loop' }>> = {}): Step[] => [
    { id: 'prep', type: 'console', run: 'prep' },
    {
      id: 'fixLoop',
      type: 'loop',
      while: 'false',
      until: '${{ steps.check.exitCode == 0 }}',
      maxIterations: 5,
      steps: [
        { id: 'review', type: 'agent', model: 'p/m', prompt: 'review ${{ loop.iteration }}' },
        {
          id: 'check',
          type: 'console',
          run: 'check ${{ steps.review.text }} ${{ steps.fix.output }} ${{ loop.iteration }}',
          continueOnError: true,
        },
        { id: 'fix', type: 'console', run: 'fix ${{ loop.iteration }}' },
      ],
      ...extra,
    },
    { id: 'after', type: 'console', run: 'after ${{ steps.fixLoop.iterations }}' },
  ];
  const outputs = {
    prep: ok({ exitCode: 0 }),
    fixLoop: { status: 'failure', iterations: 3, exitReason: 'maxIterations' } as StepOutput,
    review: ok({ text: 'R3' }),
    check: { status: 'failure', exitCode: 1, output: 'old' } as StepOutput,
    fix: ok({ exitCode: 0, output: 'F2' }),
    after: ok(),
  };

  it('continues at the stored iteration without the while check', async () => {
    const r = await run(workflow(reviewLoop()), resume('check', outputs, { fixLoop: 3 }));
    expect(r.trace).toEqual([
      'run-start',
      'end:prep:success',
      'start:fixLoop',
      'iter:fixLoop:3',
      'end:review:success',
      // fix holds iteration 2's output until it runs again (seeded, reported as reused).
      'end:fix:success',
      'start:check',
      'end:check:success',
      'start:fix',
      'end:fix:success',
      'end:fixLoop:success',
      'start:after',
      'end:after:success',
      'run:success',
    ]);
    expect(eventsOfType(r.events, 'loop-iteration')).toEqual([
      { type: 'loop-iteration', runId: 'run-1', stepId: 'fixLoop', iteration: 3, maxIterations: 5 },
    ]);
    expect(r.output('fixLoop')).toMatchObject({ iterations: 3, exitReason: 'condition' });
    expect(eventsOfType(r.events, 'step-start').find((e) => e.stepId === 'check')?.iteration).toBe(3);
  });

  it("seeds the previous iteration's outputs for the target's templates", async () => {
    const r = await run(workflow(reviewLoop()), resume('check', outputs, { fixLoop: 3 }));
    expect(r.host.consoleCalls.map((c) => c.command)).toEqual(['check R3 F2 3', 'fix 3', 'after 3']);
    // Reported as reused when the target starts, so a run continued from this one can seed it too.
    const fixEnds = eventsOfType(r.events, 'step-end').filter((e) => e.stepId === 'fix');
    expect(fixEnds.map((e) => e.reused)).toEqual([true, undefined]);
    expect(fixEnds[0]).toMatchObject({ status: 'success', output: outputs.fix, durationMs: 0 });
    const order = r.trace.filter((entry) => /fix|check/.test(entry) && !entry.includes('fixLoop'));
    expect(order).toEqual([
      'end:fix:success',
      'start:check',
      'end:check:success',
      'start:fix',
      'end:fix:success',
    ]);
  });

  it('reports no seeded blocks when the loop resumes at its first iteration', async () => {
    const r = await run(workflow(reviewLoop()), resume('check', outputs, { fixLoop: 1 }));
    const reused = eventsOfType(r.events, 'step-end').filter((e) => e.reused);
    expect(reused.map((e) => e.stepId)).toEqual(['prep', 'review']);
  });

  it('goes on with the next iteration and its checks after the resumed one', async () => {
    const host = new FakeHost().console('check', { exitCode: 1 }, { exitCode: 0 });
    const wf = workflow(reviewLoop({ while: '${{ loop.iteration <= 4 }}' }));
    const r = await run(wf, { host, ...resume('check', outputs, { fixLoop: 3 }) });
    expect(eventsOfType(r.events, 'loop-iteration').map((e) => e.iteration)).toEqual([3, 4]);
    expect(host.callOrder).toEqual(['check', 'fix', 'review', 'check', 'fix', 'after']);
    expect(r.output('fixLoop')).toMatchObject({ iterations: 4, exitReason: 'condition' });
    const reviewStart = eventsOfType(r.events, 'step-start').find((e) => e.stepId === 'review');
    expect(reviewStart?.iteration).toBe(4);
  });

  it('ends with the while check of the next iteration', async () => {
    const host = new FakeHost().console('check', { exitCode: 1 });
    const r = await run(workflow(reviewLoop()), { host, ...resume('check', outputs, { fixLoop: 3 }) });
    expect(r.output('fixLoop')).toMatchObject({ iterations: 3, exitReason: 'condition' });
    expect(host.callOrder).toEqual(['check', 'fix', 'after']);
  });

  it('runs a stored iteration past the current limit once, then the loop ends', async () => {
    const host = new FakeHost().console('check', { exitCode: 1 });
    const failing = workflow(reviewLoop({ while: undefined, maxIterations: 2 }));
    const r = await run(failing, { host, ...resume('check', outputs, { fixLoop: 7 }) });
    expect(eventsOfType(r.events, 'loop-iteration')).toEqual([
      { type: 'loop-iteration', runId: 'run-1', stepId: 'fixLoop', iteration: 7, maxIterations: 2 },
    ]);
    expect(r.output('fixLoop')).toMatchObject({
      status: 'failure',
      iterations: 7,
      exitReason: 'maxIterations',
    });
    expect(r.summary.error).toBe(
      "Loop 'fixLoop' reached its limit of 2 iterations without meeting its condition",
    );

    const lenientLimit = workflow(
      reviewLoop({ while: undefined, maxIterations: 2, onMaxIterations: 'continue' }),
    );
    const r2 = await run(lenientLimit, { host, ...resume('check', outputs, { fixLoop: 7 }) });
    expect(r2.output('fixLoop')).toMatchObject({
      status: 'success',
      iterations: 7,
      exitReason: 'maxIterations',
    });
  });

  it.each([
    ['missing', {}],
    ['zero', { fixLoop: 0 }],
    ['negative', { fixLoop: -2 }],
    ['fractional', { fixLoop: 2.5 }],
    ['not a number', { fixLoop: Number.NaN }],
  ])('starts at iteration 1 without seeding when the iteration is %s', async (_label, loopIterations) => {
    const r = await run(workflow(reviewLoop()), resume('check', outputs, loopIterations));
    expect(eventsOfType(r.events, 'loop-iteration').map((e) => e.iteration)).toEqual([1]);
    expect(r.host.consoleCalls[0].command).toBe('check R3  1');
  });

  it('runs the blocks before the target in later iterations', async () => {
    const host = new FakeHost().console('check', { exitCode: 1 }, { exitCode: 0 });
    const r = await run(workflow(reviewLoop({ while: undefined })), {
      host,
      ...resume('check', outputs, { fixLoop: 1 }),
    });
    expect(r.trace).toEqual([
      'run-start',
      'end:prep:success',
      'start:fixLoop',
      'iter:fixLoop:1',
      'end:review:success',
      'start:check',
      'end:check:failure',
      'start:fix',
      'end:fix:success',
      'iter:fixLoop:2',
      'start:review',
      'end:review:success',
      'start:check',
      'end:check:success',
      'start:fix',
      'end:fix:success',
      'end:fixLoop:success',
      'start:after',
      'end:after:success',
      'run:success',
    ]);
  });

  it('ignores a reused break in the resumed iteration', async () => {
    const wf = workflow([
      {
        id: 'l',
        type: 'loop',
        until: 'true',
        maxIterations: 5,
        steps: [
          { id: 'out', type: 'break' },
          { id: 'target', type: 'console', run: 'target ${{ loop.iteration }}' },
        ],
      },
    ]);
    const r = await run(wf, resume('target', { out: ok() }, { l: 2 }));
    expect(r.trace).toEqual([
      'run-start',
      'start:l',
      'iter:l:2',
      'end:out:success',
      'start:target',
      'end:target:success',
      'end:l:success',
      'run:success',
    ]);
    expect(r.output('l')).toMatchObject({ iterations: 2, exitReason: 'condition' });
  });

  it('continues nested loops each at its own iteration', async () => {
    const wf = workflow([
      {
        id: 'outer',
        type: 'loop',
        until: 'true',
        maxIterations: 5,
        steps: [
          { id: 'o1', type: 'console', run: 'o1' },
          {
            id: 'inner',
            type: 'loop',
            until: 'true',
            maxIterations: 4,
            steps: [
              { id: 'i1', type: 'console', run: 'i1' },
              { id: 'target', type: 'console', run: 'target ${{ loop.iteration }} ${{ steps.late.output }}' },
            ],
          },
          { id: 'late', type: 'console', run: 'late' },
        ],
      },
    ]);
    const stored = { o1: ok(), i1: ok(), target: ok(), late: ok({ output: 'L' }), inner: ok() };
    const r = await run(wf, resume('target', stored, { outer: 2, inner: 3 }));
    expect(r.trace).toEqual([
      'run-start',
      'start:outer',
      'iter:outer:2',
      'end:o1:success',
      'start:inner',
      'iter:inner:3',
      'end:i1:success',
      'end:late:success',
      'start:target',
      'end:target:success',
      'end:inner:success',
      'start:late',
      'end:late:success',
      'end:outer:success',
      'run:success',
    ]);
    expect(r.host.consoleCalls[0].command).toBe('target 3 L');
    expect(eventsOfType(r.events, 'step-start').find((e) => e.stepId === 'inner')?.iteration).toBe(2);
    expect(r.output('outer')).toMatchObject({ iterations: 2 });
    expect(r.output('inner')).toMatchObject({ iterations: 3 });
  });

  it('cancels the resumed iteration on abort', async () => {
    const controller = new AbortController();
    const host = new FakeHost().console('check', () => {
      setTimeout(() => controller.abort(), 5);
      return { hang: true };
    });
    const r = await run(workflow(reviewLoop()), {
      host,
      signal: controller.signal,
      ...resume('check', outputs, { fixLoop: 3 }),
    });
    expect(r.summary.status).toBe('cancelled');
    expect(r.output('check')?.status).toBe('cancelled');
    expect(r.output('fixLoop')).toMatchObject({ status: 'cancelled', iterations: 3 });
    expect(host.callOrder).toEqual(['check']);
  });
});

describe('resume inside an if', () => {
  const wf = workflow([
    { id: 'tests', type: 'console', run: 'tests' },
    {
      id: 'gate',
      type: 'if',
      condition: '${{ steps.tests.exitCode == 0 }}',
      then: [{ id: 'ship', type: 'console', run: 'ship' }],
      else: [
        { id: 'diagnose', type: 'console', run: 'diagnose' },
        { id: 'repair', type: 'console', run: 'repair ${{ steps.diagnose.output }}' },
      ],
    },
    { id: 'report', type: 'console', run: 'report' },
  ]);
  const outputs = {
    tests: ok({ exitCode: 0 }),
    gate: ok({ branch: 'then', result: true }),
    ship: ok(),
    diagnose: ok({ output: 'D' }),
  };

  it('takes the branch that contains the target without checking the condition', async () => {
    const r = await run(wf, resume('repair', outputs));
    expect(r.trace).toEqual([
      'run-start',
      'end:tests:success',
      'start:gate',
      'end:ship:skipped',
      'end:diagnose:success',
      'start:repair',
      'end:repair:success',
      'end:gate:success',
      'start:report',
      'end:report:success',
      'run:success',
    ]);
    expect(r.output('gate')).toMatchObject({ branch: 'else', result: false });
    expect(r.host.consoleCalls[0].command).toBe('repair D');
    expect(eventsOfType(r.events, 'step-end').find((e) => e.stepId === 'ship')).not.toHaveProperty('reused');
  });

  it('takes the then branch when the target is there', async () => {
    const r = await run(wf, resume('ship', { tests: ok({ exitCode: 1 }) }));
    expect(r.output('gate')).toMatchObject({ branch: 'then', result: true });
    expect(r.trace).toContain('end:diagnose:skipped');
    expect(r.host.callOrder).toEqual(['ship', 'report']);
  });

  it('checks the condition again when the if is retried', async () => {
    const retried = workflow([
      {
        id: 'gate',
        type: 'if',
        condition: 'true',
        retry: { max: 1 },
        then: [{ id: 'yes', type: 'console', run: 'yes' }],
        else: [{ id: 'no', type: 'console', run: 'no', continueOnError: false }],
      },
    ]);
    const host = new FakeHost().console('no', { exitCode: 1 });
    const r = await run(retried, { host, ...resume('no') });
    expect(host.callOrder).toEqual(['no', 'yes']);
    expect(r.output('gate')).toMatchObject({ branch: 'then', status: 'success' });
  });
});

describe('resume inside a loop in an if in a loop', () => {
  const wf = workflow([
    {
      id: 'outer',
      type: 'loop',
      until: '${{ steps.done.exitCode == 0 }}',
      maxIterations: 4,
      steps: [
        { id: 'probe', type: 'console', run: 'probe' },
        {
          id: 'gate',
          type: 'if',
          condition: '${{ steps.probe.exitCode == 0 }}',
          then: [{ id: 'skipIt', type: 'console', run: 'skip' }],
          else: [
            {
              id: 'inner',
              type: 'loop',
              until: '${{ steps.fix.exitCode == 0 }}',
              maxIterations: 5,
              steps: [
                { id: 'fix', type: 'console', run: 'fix ${{ loop.iteration }} ${{ steps.verify.output }}' },
                { id: 'verify', type: 'console', run: 'verify' },
              ],
            },
          ],
        },
        { id: 'done', type: 'console', run: 'done', continueOnError: true },
      ],
    },
    { id: 'after', type: 'console', run: 'after' },
  ]);
  const stored = {
    probe: ok({ exitCode: 0 }),
    gate: ok({ branch: 'then', result: true }),
    skipIt: ok(),
    inner: ok({ iterations: 3 }),
    fix: { status: 'failure', exitCode: 1 } as StepOutput,
    verify: ok({ output: 'V2' }),
    done: ok({ exitCode: 1 }),
  };

  it('enters each container at the stored place and runs only from the target on', async () => {
    const host = new FakeHost().console('done', { exitCode: 0 });
    const r = await run(wf, { host, ...resume('fix', stored, { outer: 2, inner: 3 }) });
    expect(r.trace).toEqual([
      'run-start',
      'start:outer',
      'iter:outer:2',
      'end:probe:success',
      'start:gate',
      'end:skipIt:skipped',
      'start:inner',
      'iter:inner:3',
      'end:verify:success',
      'end:done:success',
      'start:fix',
      'end:fix:success',
      'start:verify',
      'end:verify:success',
      'end:inner:success',
      'end:gate:success',
      'start:done',
      'end:done:success',
      'end:outer:success',
      'start:after',
      'end:after:success',
      'run:success',
    ]);
    // Neither the outer while/until nor the if condition was evaluated before the target; probe never ran.
    expect(host.callOrder).toEqual(['fix', 'verify', 'done', 'after']);
    expect(host.consoleCalls[0].command).toBe('fix 3 V2');
    expect(r.output('gate')).toMatchObject({ branch: 'else', result: false });
    expect(r.output('inner')).toMatchObject({ iterations: 3, exitReason: 'condition' });
    expect(r.output('outer')).toMatchObject({ iterations: 2, exitReason: 'condition' });
  });

  it('evaluates the if again in the next outer iteration', async () => {
    const host = new FakeHost()
      .console('done', { exitCode: 1 }, { exitCode: 0 })
      .console('probe', { exitCode: 0 });
    const r = await run(wf, { host, ...resume('fix', stored, { outer: 2, inner: 3 }) });
    expect(host.callOrder).toEqual(['fix', 'verify', 'done', 'probe', 'skipIt', 'done', 'after']);
    expect(r.output('gate')).toMatchObject({ branch: 'then', result: true });
    expect(r.output('outer')).toMatchObject({ iterations: 3 });
  });
});
