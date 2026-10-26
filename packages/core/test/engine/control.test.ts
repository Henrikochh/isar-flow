import { describe, expect, it } from 'vitest';
import type { Step } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, run, workflow } from './helpers';

const branchy = (condition: string): Step[] => [
  {
    id: 'gate',
    type: 'if',
    condition,
    then: [{ id: 't1', type: 'console', run: 'then' }],
    else: [
      { id: 'e1', type: 'console', run: 'else' },
      {
        id: 'e2',
        type: 'loop',
        maxIterations: 2,
        steps: [
          { id: 'e3', type: 'if', condition: 'true', then: [{ id: 'e4', type: 'console', run: 'deep' }] },
        ],
      },
    ],
  },
  {
    id: 'after',
    type: 'console',
    run: '${{ steps.gate.branch }} ${{ steps.e1.status }} ${{ steps.t1.status }}',
  },
];

describe('if blocks', () => {
  it('runs then and reports every else block as skipped, recursively', async () => {
    const host = new FakeHost();
    const r = await run(workflow(branchy('true')), { host });
    expect(r.trace).toEqual([
      'run-start',
      'start:gate',
      'end:e1:skipped',
      'end:e2:skipped',
      'end:e3:skipped',
      'end:e4:skipped',
      'start:t1',
      'end:t1:success',
      'end:gate:success',
      'start:after',
      'end:after:success',
      'run:success',
    ]);
    expect(r.output('gate')).toEqual({
      branch: 'then',
      result: true,
      status: 'success',
      durationMs: expect.any(Number),
    });
    expect(host.consoleCalls.at(-1)?.command).toBe('then skipped success');
    const skipped = eventsOfType(r.events, 'step-end').find((e) => e.stepId === 'e4');
    expect(skipped).toMatchObject({
      status: 'skipped',
      output: { status: 'skipped', durationMs: 0 },
      durationMs: 0,
    });
    expect(r.summary.steps.e4.status).toBe('skipped');
  });

  it('runs else and reports then blocks as skipped', async () => {
    const host = new FakeHost();
    const r = await run(workflow(branchy("${{ inputs.mode == 'fast' }}")), {
      host,
      inputs: { mode: 'slow' },
    });
    expect(r.trace.slice(0, 4)).toEqual(['run-start', 'start:gate', 'end:t1:skipped', 'start:e1']);
    expect(r.output('gate')).toMatchObject({ branch: 'else', result: false });
    expect(host.callOrder).toEqual(['e1', 'e4', 'e4', 'after']);
    expect(host.consoleCalls.at(-1)?.command).toBe('else success skipped');
  });

  it('handles a missing else branch', async () => {
    const r = await run(
      workflow([
        {
          id: 'gate',
          type: 'if',
          condition: { value: 1, op: 'gt', to: 2 },
          then: [{ id: 't', type: 'console', run: 'x' }],
        },
      ]),
    );
    expect(r.trace).toEqual(['run-start', 'start:gate', 'end:t:skipped', 'end:gate:success', 'run:success']);
  });

  it('fails the if block when a branch block fails', async () => {
    const host = new FakeHost().console('t1', { exitCode: 1 });
    const r = await run(workflow(branchy('true')), { host });
    expect(r.output('gate')).toMatchObject({ branch: 'then', status: 'failure' });
    expect(r.error('gate')).toBe("Block 't1' failed: Command exited with code 1");
    expect(r.summary.error).toBe("Block 't1' failed: Command exited with code 1");
  });

  it('reports expression errors in the condition', async () => {
    const r = await run(workflow([{ id: 'gate', type: 'if', condition: '${{ 1 + }}', then: [] }]));
    expect(r.error('gate')).toMatch(/^Expression error in condition: /);
  });
});

describe('stop blocks', () => {
  it('ends the run successfully right away with outcome success', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 3,
          steps: [
            { id: 'done', type: 'stop', outcome: 'success', message: 'All good at ${{ loop.iteration }}' },
          ],
        },
        { id: 'after', type: 'console', run: 'never' },
      ]),
      { host },
    );
    expect(r.trace).toEqual([
      'run-start',
      'start:l',
      'iter:l:1',
      'start:done',
      'end:done:success',
      'end:l:success',
      'run:success',
    ]);
    expect(eventsOfType(r.events, 'step-start')[1].detail).toBe('All good at 1');
    expect(r.summary.status).toBe('success');
    expect(r.summary.error).toBeUndefined();
    expect(host.calls).toHaveLength(0);
  });

  it('fails the run with the rendered message by default', async () => {
    const r = await run(
      workflow([
        { id: 's', type: 'stop', message: 'Tests failed for ${{ inputs.task }}', continueOnError: true },
        { id: 'after', type: 'console', run: 'never' },
      ]),
      { inputs: { task: 'login' } },
    );
    expect(r.trace).toEqual(['run-start', 'start:s', 'end:s:failure', 'run:failure']);
    expect(r.error('s')).toBe('Tests failed for login');
    expect(r.summary.error).toBe('Tests failed for login');
  });

  it('uses "Stopped by block \'x\'" without a message and is not caught by enclosing continueOnError', async () => {
    const r = await run(
      workflow([
        {
          id: 'gate',
          type: 'if',
          condition: 'true',
          continueOnError: true,
          then: [{ id: 'halt', type: 'stop', outcome: 'failure' }],
        },
        { id: 'after', type: 'console', run: 'never' },
      ]),
    );
    expect(r.summary).toMatchObject({ status: 'failure', error: "Stopped by block 'halt'" });
    expect(r.output('gate')?.status).toBe('failure');
    expect(r.trace).not.toContain('start:after');
  });

  it('reports expression errors in the message as an ordinary block failure', async () => {
    const r = await run(workflow([{ id: 's', type: 'stop', outcome: 'success', message: '${{ ( }}' }]));
    expect(r.error('s')).toMatch(/^Expression error in message: /);
    expect(r.summary).toMatchObject({
      status: 'failure',
      error: expect.stringMatching(/^Block 's' failed: /),
    });
  });
});

describe('approval blocks', () => {
  it('asks the host with the rendered message and exposes the answer', async () => {
    const host = new FakeHost().approval('ok', { approved: true, comment: 'ship it' });
    const r = await run(
      workflow([
        { id: 'ok', type: 'approval', message: 'Deploy ${{ inputs.v }}?' },
        { id: 'after', type: 'console', run: '${{ steps.ok.approved }} ${{ steps.ok.comment }}' },
      ]),
      { host, inputs: { v: '1.2' } },
    );
    expect(host.approvalCalls).toEqual([{ stepId: 'ok', message: 'Deploy 1.2?' }]);
    expect(eventsOfType(r.events, 'step-start')[0]).toMatchObject({
      stepType: 'approval',
      detail: 'Deploy 1.2?',
    });
    expect(r.output('ok')).toEqual({
      approved: true,
      comment: 'ship it',
      status: 'success',
      durationMs: expect.any(Number),
    });
    expect(host.consoleCalls[0].command).toBe('true ship it');
  });

  it('fails the run when rejected with onReject: stop (default)', async () => {
    const host = new FakeHost().approval('gate', { approved: false });
    const r = await run(
      workflow([
        { id: 'gate', type: 'approval', message: 'OK?', retry: { max: 2 }, continueOnError: true },
        { id: 'after', type: 'console', run: 'never' },
      ]),
      { host },
    );
    expect(r.trace).toEqual(['run-start', 'start:gate', 'end:gate:failure', 'run:failure']);
    expect(r.output('gate')).toMatchObject({ approved: false, comment: '', status: 'failure' });
    expect(r.summary.error).toBe("Rejected at 'gate'");
    expect(host.approvalCalls).toHaveLength(1);
  });

  it('includes the reviewer comment in the rejection', async () => {
    const host = new FakeHost().approval('gate', { approved: false, comment: 'Needs tests' });
    const r = await run(workflow([{ id: 'gate', type: 'approval', message: 'OK?' }]), { host });
    expect(r.summary.error).toBe("Rejected at 'gate': Needs tests");
    expect(r.error('gate')).toBe("Rejected at 'gate': Needs tests");
  });

  it('continues when rejected with onReject: continue', async () => {
    const host = new FakeHost().approval('gate', { approved: false, comment: 'nope' });
    const r = await run(
      workflow([
        { id: 'gate', type: 'approval', message: 'OK?', onReject: 'continue' },
        { id: 'after', type: 'console', run: '${{ steps.gate.approved }}' },
      ]),
      { host },
    );
    expect(r.summary.status).toBe('success');
    expect(r.output('gate')).toMatchObject({ approved: false, comment: 'nope', status: 'success' });
    expect(host.consoleCalls[0].command).toBe('false');
  });

  it('reports expression errors in the message', async () => {
    const r = await run(workflow([{ id: 'gate', type: 'approval', message: '${{ ! }}' }]));
    expect(r.error('gate')).toMatch(/^Expression error in message: /);
  });
});
