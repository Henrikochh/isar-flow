import { describe, expect, it } from 'vitest';
import { runWorkflow } from '../../src/engine';
import type { RunEvent } from '../../src/engine/types';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, fakeClock, run, traceOf, workflow } from './helpers';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe('retry', () => {
  it('re-runs a failing block until it succeeds and logs each retry', async () => {
    const host = new FakeHost().console(
      'flaky',
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 0, stdout: 'ok' },
    );
    const r = await run(workflow([{ id: 'flaky', type: 'console', run: 'x', retry: { max: 2 } }]), { host });
    expect(host.consoleCalls).toHaveLength(3);
    expect(r.trace).toEqual([
      'run-start',
      'start:flaky',
      'log:flaky:info:Attempt 1 failed: Command exited with code 1. Retrying (retry 1 of 2).\n',
      'log:flaky:info:Attempt 2 failed: Command exited with code 1. Retrying (retry 2 of 2).\n',
      'end:flaky:success',
      'run:success',
    ]);
    expect(r.output('flaky')).toMatchObject({ exitCode: 0, stdout: 'ok', status: 'success' });
  });

  it('fails after the last retry', async () => {
    const host = new FakeHost().console('flaky', { exitCode: 1 });
    const r = await run(workflow([{ id: 'flaky', type: 'console', run: 'x', retry: { max: 2 } }]), { host });
    expect(host.consoleCalls).toHaveLength(3);
    expect(r.error('flaky')).toBe('Command exited with code 1');
    expect(r.summary.status).toBe('failure');
  });

  it('waits the configured delay between attempts', async () => {
    const host = new FakeHost().console('flaky', { exitCode: 1 }, { exitCode: 0 });
    const started = Date.now();
    const r = await run(
      workflow([{ id: 'flaky', type: 'console', run: 'x', retry: { max: 1, delay: 0.05 } }]),
      {
        host,
      },
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(r.trace[2]).toBe(
      'log:flaky:info:Attempt 1 failed: Command exited with code 1. Retrying in 0.05s (retry 1 of 1).\n',
    );
    expect(r.summary.status).toBe('success');
  });

  it('retries host exceptions and agent failures', async () => {
    const host = new FakeHost().agent('a', { error: 'rate limited' }, { text: 'fine' });
    const r = await run(
      workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'p', retry: { max: 1 } }]),
      { host },
    );
    expect(r.output('a')).toMatchObject({ text: 'fine', status: 'success' });
  });

  it('continues the run after the last retry fails when continueOnError is set', async () => {
    const host = new FakeHost().console('flaky', { exitCode: 4 });
    const r = await run(
      workflow([
        { id: 'flaky', type: 'console', run: 'x', retry: { max: 1 }, continueOnError: true },
        { id: 'after', type: 'console', run: 'code ${{ steps.flaky.exitCode }}' },
      ]),
      { host },
    );
    expect(host.callOrder).toEqual(['flaky', 'flaky', 'after']);
    expect(r.output('flaky')).toMatchObject({ exitCode: 4, status: 'failure' });
    expect(host.consoleCalls[2].command).toBe('code 4');
    expect(r.summary.status).toBe('success');
  });

  it('keeps retries finite when the retry settings are invalid', async () => {
    let calls = 0;
    // Fails 20 times, so an unbounded retry loop would end only on call 21.
    const failing = () => ({ exitCode: ++calls > 20 ? 0 : 1 });
    const nan = await run(
      workflow([{ id: 'a', type: 'console', run: 'x', retry: { max: Number.NaN, delay: Number.NaN } }]),
      { host: new FakeHost().console('a', failing) },
    );
    expect(calls).toBe(1);
    expect(nan.summary.status).toBe('failure');

    calls = 0;
    const huge = await run(
      workflow([{ id: 'a', type: 'console', run: 'x', retry: { max: 1000, delay: Number.NaN } }]),
      { host: new FakeHost().console('a', failing) },
    );
    expect(calls).toBe(11);
    expect(huge.trace[2]).toBe(
      'log:a:info:Attempt 1 failed: Command exited with code 1. Retrying (retry 1 of 10).\n',
    );
  });

  it('re-runs a whole container block', async () => {
    const host = new FakeHost().console('inner', { exitCode: 1 }, { exitCode: 0 });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 1,
          retry: { max: 1 },
          steps: [{ id: 'inner', type: 'console', run: 'x' }],
        },
      ]),
      { host },
    );
    expect(host.callOrder).toEqual(['inner', 'inner']);
    expect(r.output('l')?.status).toBe('success');
  });
});

describe('timeout', () => {
  it('aborts the step signal and fails the block', async () => {
    const host = new FakeHost().console('slow', { hang: true });
    const r = await run(workflow([{ id: 'slow', type: 'console', run: 'x', timeout: 0.05 }]), { host });
    expect(r.error('slow')).toBe('Timed out after 0.05s');
    expect(r.output('slow')?.status).toBe('failure');
    expect(r.summary).toMatchObject({
      status: 'failure',
      error: "Block 'slow' failed: Timed out after 0.05s",
    });
    expect(host.calls[0].io.signal.aborted).toBe(true);
  });

  it('marks a console block as timedOut when the engine timer ends it', async () => {
    const host = new FakeHost().console('slow', { hang: true });
    const r = await run(workflow([{ id: 'slow', type: 'console', run: 'x', timeout: 0.05 }]), { host });
    expect(r.output('slow')).toMatchObject({ timedOut: true, status: 'failure' });
    expect(r.error('slow')).toBe('Timed out after 0.05s');
  });

  it('keeps partial console output and still reports timedOut when the host answers after the abort', async () => {
    // A real console host kills the process on abort and reports what it captured, without its own timeout flag.
    const host = new FakeHost().console('slow', (_req, io) => {
      io.log('stdout', 'partial\n');
      return new Promise((resolve) =>
        io.signal.addEventListener('abort', () =>
          resolve({ exitCode: 1, stdout: 'partial\n', timedOut: false }),
        ),
      );
    });
    const r = await run(
      workflow([
        { id: 'slow', type: 'console', run: 'x', timeout: 0.05, continueOnError: true },
        { id: 'after', type: 'console', run: '${{ steps.slow.timedOut }} ${{ trim(steps.slow.stdout) }}' },
      ]),
      { host },
    );
    expect(r.output('slow')).toMatchObject({
      exitCode: 1,
      stdout: 'partial\n',
      timedOut: true,
      status: 'failure',
    });
    expect(host.consoleCalls[1].command).toBe('true partial');
  });

  it('does not report timedOut for console blocks cancelled by the run', async () => {
    const controller = new AbortController();
    const host = new FakeHost().console('long', () => {
      setTimeout(() => controller.abort(), 5);
      return { hang: true };
    });
    const r = await run(workflow([{ id: 'long', type: 'console', run: 'x', timeout: 60 }]), {
      host,
      signal: controller.signal,
    });
    expect(r.output('long')?.status).toBe('cancelled');
    expect(r.output('long')?.timedOut).toBeUndefined();
  });

  it('supports timeouts longer than the platform timer limit (about 24.8 days)', async () => {
    const thirtyDays = 30 * 24 * 60 * 60;
    const host = new FakeHost().console('wait', { delayMs: 30, stdout: 'done' });
    const r = await run(workflow([{ id: 'wait', type: 'console', run: 'x', timeout: thirtyDays }]), { host });
    expect(r.output('wait')).toMatchObject({ stdout: 'done', status: 'success' });
    expect(host.calls[0].io.signal.aborted).toBe(false);
    expect(host.consoleCalls[0].timeoutMs).toBe(2_147_483_647);
  });

  it('can be combined with retry and continueOnError', async () => {
    const host = new FakeHost().agent('a', { hang: true }, { text: 'quick' });
    const r = await run(
      workflow([
        { id: 'a', type: 'agent', model: 'p/m', prompt: 'p', timeout: 0.05, retry: { max: 1 } },
        { id: 'b', type: 'approval', message: 'm', timeout: 0.05, continueOnError: true },
        { id: 'c', type: 'console', run: 'after' },
      ]),
      { host: host.approval('b', { hang: true }) },
    );
    expect(r.output('a')).toMatchObject({ text: 'quick', status: 'success' });
    expect(r.error('b')).toBe('Timed out after 0.05s');
    expect(r.summary.status).toBe('success');
    expect(host.callOrder).toEqual(['a', 'a', 'b', 'c']);
  });

  it('times out container blocks and cancels the running child', async () => {
    const host = new FakeHost().console('inner', { hang: true });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 3,
          timeout: 0.05,
          steps: [{ id: 'inner', type: 'console', run: 'x' }],
        },
      ]),
      { host },
    );
    expect(r.trace).toEqual([
      'run-start',
      'start:l',
      'iter:l:1',
      'start:inner',
      'end:inner:cancelled',
      'end:l:failure',
      'run:failure',
    ]);
    expect(r.error('l')).toBe('Timed out after 0.05s');
    expect(r.summary.error).toBe("Block 'l' failed: Timed out after 0.05s");
  });

  it('does not wait forever for a host that ignores the abort signal', async () => {
    const host = new FakeHost().console('stuck', { hang: true, ignoreAbort: true });
    const r = await run(workflow([{ id: 'stuck', type: 'console', run: 'x', timeout: 0.02 }]), { host });
    expect(r.error('stuck')).toBe('Timed out after 0.02s');
  }, 5_000);
});

describe('cancellation', () => {
  it('ends the running block as cancelled and runs nothing else', async () => {
    const controller = new AbortController();
    const host = new FakeHost().console('long', (_req, io) => {
      io.log('stdout', 'working\n');
      setTimeout(() => controller.abort(), 5);
      return { hang: true };
    });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 3,
          steps: [{ id: 'long', type: 'console', run: 'x', retry: { max: 3 } }],
        },
        { id: 'after', type: 'console', run: 'never' },
      ]),
      { host, signal: controller.signal },
    );
    expect(r.trace).toEqual([
      'run-start',
      'start:l',
      'iter:l:1',
      'start:long',
      'log:long:stdout:working\n',
      'end:long:cancelled',
      'end:l:cancelled',
      'run:cancelled',
    ]);
    expect(r.summary.status).toBe('cancelled');
    expect(r.summary.steps.long.status).toBe('cancelled');
    expect(host.calls[0].io.signal.aborted).toBe(true);
  });

  it('cancels during agent streaming and approval waits', async () => {
    for (const kind of ['agent', 'approval'] as const) {
      const controller = new AbortController();
      const host = new FakeHost();
      const script = () => {
        setTimeout(() => controller.abort(), 5);
        return { hang: true };
      };
      if (kind === 'agent') host.agent('x', script);
      else host.approval('x', script);
      const step =
        kind === 'agent'
          ? { id: 'x', type: 'agent' as const, model: 'p/m', prompt: 'p' }
          : { id: 'x', type: 'approval' as const, message: 'm' };
      const r = await run(workflow([step]), { host, signal: controller.signal });
      expect(r.trace).toEqual(['run-start', 'start:x', 'end:x:cancelled', 'run:cancelled']);
    }
  });

  it('reports a cancelled approval as cancelled, not rejected, when the host answers during the grace period', async () => {
    const controller = new AbortController();
    const host = new FakeHost().approval('gate', (_req, io) => {
      setTimeout(() => controller.abort(), 5);
      return new Promise((resolve) =>
        io.signal.addEventListener('abort', () => resolve({ approved: false })),
      );
    });
    const r = await run(workflow([{ id: 'gate', type: 'approval', message: 'Ship?' }]), {
      host,
      signal: controller.signal,
    });
    expect(r.trace).toEqual(['run-start', 'start:gate', 'end:gate:cancelled', 'run:cancelled']);
    expect(r.summary.error).toBeUndefined();
  });

  it('cancels during a retry delay', async () => {
    const controller = new AbortController();
    const host = new FakeHost().console('flaky', () => {
      setTimeout(() => controller.abort(), 5);
      return { exitCode: 1 };
    });
    const started = Date.now();
    const r = await run(
      workflow([{ id: 'flaky', type: 'console', run: 'x', retry: { max: 3, delay: 30 } }]),
      {
        host,
        signal: controller.signal,
      },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(host.consoleCalls).toHaveLength(1);
    expect(r.output('flaky')?.status).toBe('cancelled');
    expect(r.summary.status).toBe('cancelled');
  });

  it('does not start when the signal is already aborted', async () => {
    const host = new FakeHost();
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), {
      host,
      signal: AbortSignal.abort(),
    });
    expect(r.trace).toEqual(['run-start', 'run:cancelled']);
    expect(host.calls).toHaveLength(0);
  });

  it('finishes even when the host ignores the abort signal', async () => {
    const controller = new AbortController();
    const host = new FakeHost().console('stuck', () => {
      setTimeout(() => controller.abort(), 5);
      return { hang: true, ignoreAbort: true };
    });
    const r = await run(workflow([{ id: 'stuck', type: 'console', run: 'x' }]), {
      host,
      signal: controller.signal,
    });
    expect(r.summary.status).toBe('cancelled');
  }, 5_000);

  it('aborts the run when the consumer stops iterating early', async () => {
    const host = new FakeHost().console('long', { hang: true });
    const gen = runWorkflow(workflow([{ id: 'long', type: 'console', run: 'x' }]), {
      runId: 'r',
      inputs: {},
      agents: {},
      workspaceRoot: '/ws',
      host,
    });
    const seen: RunEvent[] = [];
    for await (const event of gen) {
      seen.push(event);
      if (event.type === 'step-start') break;
    }
    expect(traceOf(seen)).toEqual(['run-start', 'start:long']);
    expect(host.calls[0].io.signal.aborted).toBe(true);
  });
});

describe('step logs', () => {
  it('interleaves logs from async host callbacks in causal order', async () => {
    const host = new FakeHost()
      .console('a', async (_req, io) => {
        io.log('stdout', 'a1\n');
        await tick();
        io.log('stderr', 'a2\n');
        await tick();
        io.log('stdout', 'a3\n');
        return { exitCode: 0 };
      })
      .agent('b', async (_req, io) => {
        io.log('agent', 'thinking');
        await tick();
        io.log('tool', 'readFile src/a.ts\n');
        return { text: 'done' };
      });
    const r = await run(
      workflow([
        { id: 'a', type: 'console', run: 'x' },
        { id: 'b', type: 'agent', model: 'p/m', prompt: 'p' },
      ]),
      { host },
    );
    expect(r.trace).toEqual([
      'run-start',
      'start:a',
      'log:a:stdout:a1\n',
      'log:a:stderr:a2\n',
      'log:a:stdout:a3\n',
      'end:a:success',
      'start:b',
      'log:b:agent:thinking',
      'log:b:tool:readFile src/a.ts\n',
      'end:b:success',
      'run:success',
    ]);
    expect(eventsOfType(r.events, 'step-log')[0]).toEqual({
      type: 'step-log',
      runId: 'run-1',
      stepId: 'a',
      stream: 'stdout',
      text: 'a1\n',
    });
  });

  it('passes runId and stepId in StepIO and drops logs after the block ended', async () => {
    let late: (() => void) | undefined;
    const host = new FakeHost().console('a', (req, io) => {
      expect(io).toMatchObject({ runId: 'run-1', stepId: 'a' });
      late = () => io.log('stdout', 'too late\n');
      return { exitCode: 0 };
    });
    const gen = runWorkflow(
      workflow([
        { id: 'a', type: 'console', run: 'x' },
        { id: 'b', type: 'console', run: 'y' },
      ]),
      { runId: 'run-1', inputs: {}, agents: {}, workspaceRoot: '/ws', host, now: fakeClock() },
    );
    const events: RunEvent[] = [];
    for await (const event of gen) {
      events.push(event);
      if (event.type === 'step-end' && event.stepId === 'a') late?.();
    }
    expect(traceOf(events)).not.toContain('log:a:stdout:too late\n');
  });

  it('ignores empty log chunks', async () => {
    const host = new FakeHost().console('a', { logs: [{ stream: 'stdout', text: '' }] });
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { host });
    expect(eventsOfType(r.events, 'step-log')).toHaveLength(0);
  });
});
