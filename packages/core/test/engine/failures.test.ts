import { describe, expect, it } from 'vitest';
import * as core from '../../src';
import { AgentRunError } from '../../src/engine';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, run, workflow } from './helpers';

describe('steps.<id>.error', () => {
  it('holds the error of a failed block and can be read by later blocks', async () => {
    const host = new FakeHost()
      .console('tests', { exitCode: 2 })
      .agent('review', { error: 'The provider is rate limiting requests' });
    const r = await run(
      workflow([
        { id: 'tests', type: 'console', run: 'npm test', continueOnError: true },
        { id: 'review', type: 'agent', model: 'p/m', prompt: 'p', continueOnError: true },
        { id: 'report', type: 'console', run: '${{ steps.tests.error }} / ${{ steps.review.error }}' },
      ]),
      { host },
    );
    expect(r.output('tests')).toMatchObject({ status: 'failure', error: 'Command exited with code 2' });
    expect(r.output('review')).toEqual({
      status: 'failure',
      durationMs: expect.any(Number),
      error: 'The provider is rate limiting requests',
    });
    expect(host.consoleCalls[1].command).toBe(
      'Command exited with code 2 / The provider is rate limiting requests',
    );
    expect(r.summary.steps.tests.error).toBe('Command exited with code 2');
  });

  it('matches the step-end error for every failed block', async () => {
    const host = new FakeHost().console('slow', { hang: true });
    const r = await run(
      workflow([
        { id: 'slow', type: 'console', run: 'x', timeout: 0.02, continueOnError: true },
        { id: 'bad', type: 'console', run: '${{ + }}', continueOnError: true },
        { id: 'gate', type: 'approval', message: 'm', onReject: 'continue' },
        {
          id: 'l',
          type: 'loop',
          maxIterations: 1,
          until: 'false',
          continueOnError: true,
          steps: [{ id: 'inner', type: 'stop', message: 'Inner stop' }],
        },
      ]),
      { host: host.approval('gate', { approved: false }) },
    );
    for (const end of eventsOfType(r.events, 'step-end')) {
      if (end.status === 'failure') expect(end.output.error).toBe(end.error);
      else expect(end.output).not.toHaveProperty('error');
    }
    expect(r.output('slow')?.error).toBe('Timed out after 0.02s');
    expect(r.output('bad')?.error).toMatch(/^Expression error in run: /);
    expect(r.output('gate')?.status).toBe('success');
    expect(r.output('inner')?.error).toBe('Inner stop');
  });

  it('is not set for blocks that succeeded or were skipped', async () => {
    const r = await run(
      workflow([
        { id: 'ok', type: 'console', run: 'x' },
        { id: 'gate', type: 'if', condition: 'false', then: [{ id: 'never', type: 'console', run: 'y' }] },
      ]),
    );
    expect(r.output('ok')).not.toHaveProperty('error');
    expect(r.output('never')).toEqual({ status: 'skipped', durationMs: 0 });
  });

  it('says Cancelled for cancelled blocks', async () => {
    const controller = new AbortController();
    const host = new FakeHost().console('long', () => {
      setTimeout(() => controller.abort(), 5);
      return { hang: true };
    });
    const r = await run(
      workflow([
        { id: 'l', type: 'loop', maxIterations: 2, steps: [{ id: 'long', type: 'console', run: 'x' }] },
      ]),
      { host, signal: controller.signal },
    );
    expect(r.error('long')).toBe('Cancelled');
    expect(r.output('long')).toMatchObject({ status: 'cancelled', error: 'Cancelled' });
    expect(r.output('l')).toMatchObject({ status: 'cancelled', error: 'Cancelled' });
    expect(r.summary.error).toBeUndefined();
  });
});

describe('usage of failed agent blocks', () => {
  it('exports AgentRunError and the secret mask from the package', () => {
    expect(core.AgentRunError).toBe(AgentRunError);
    expect(core.SECRET_MASK).toBe('••••••');
  });

  const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

  it('counts usage carried by AgentRunError towards the run and shows it on the block', async () => {
    const host = new FakeHost()
      .agent('a', { error: new AgentRunError('The agent used all 2 turns', usage(30, 5)) })
      .agent('b', { usage: usage(1, 1) });
    const r = await run(
      workflow([
        { id: 'a', type: 'agent', model: 'p/m', prompt: 'x', continueOnError: true },
        { id: 'b', type: 'agent', model: 'p/m', prompt: 'y' },
      ]),
      { host },
    );
    expect(r.output('a')).toEqual({
      usage: usage(30, 5),
      status: 'failure',
      durationMs: expect.any(Number),
      error: 'The agent used all 2 turns',
    });
    expect(r.summary.usage).toEqual(usage(31, 6));
    expect(r.events.at(-1)).toMatchObject({ type: 'run-end', usage: usage(31, 6) });
  });

  it('shows the tool calls a failed agent block made', async () => {
    const host = new FakeHost().agent('a', {
      error: new AgentRunError('The agent used all 2 turns', usage(30, 5), { toolCalls: 2 }),
    });
    const r = await run(
      workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x', continueOnError: true }]),
      { host },
    );
    expect(r.output('a')).toMatchObject({ status: 'failure', usage: usage(30, 5), toolCalls: 2 });
  });

  it('counts the tool calls of failed attempts that are retried', async () => {
    const host = new FakeHost().agent(
      'a',
      { error: new AgentRunError('bad JSON', usage(10, 2), { toolCalls: 3 }) },
      { usage: usage(5, 1), toolCalls: 1 },
    );
    const r = await run(
      workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x', retry: { max: 1 } }]),
      { host },
    );
    expect(r.output('a')).toMatchObject({ status: 'success', usage: usage(15, 3), toolCalls: 4 });
  });

  it('counts usage of failed attempts that are retried', async () => {
    const host = new FakeHost().agent(
      'a',
      { error: new AgentRunError('bad JSON', usage(10, 2)) },
      { usage: usage(5, 1) },
    );
    const r = await run(
      workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x', retry: { max: 1 } }]),
      { host },
    );
    // The block's usage covers every attempt, so the blocks' tokens add up to the run total.
    expect(r.output('a')).toMatchObject({ status: 'success', usage: usage(15, 3) });
    expect(r.summary.usage).toEqual(usage(15, 3));
  });

  it('sums the usage of every attempt of a block that keeps failing', async () => {
    const host = new FakeHost().agent(
      'a',
      { error: new AgentRunError('bad JSON', usage(10, 2)) },
      { error: 'model is down' },
      { error: new AgentRunError('bad JSON again', usage(4, 1)) },
    );
    const r = await run(
      workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x', retry: { max: 2 } }]),
      { host },
    );
    expect(host.agentCalls).toHaveLength(3);
    expect(r.output('a')).toMatchObject({ status: 'failure', usage: usage(14, 3), error: 'bad JSON again' });
    expect(r.summary.usage).toEqual(usage(14, 3));
  });

  it('keeps the usage of earlier attempts when the last attempt reports none', async () => {
    const host = new FakeHost().agent(
      'a',
      { error: new AgentRunError('bad JSON', usage(10, 2)) },
      { error: 'model is down' },
    );
    const r = await run(
      workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x', retry: { max: 1 } }]),
      { host },
    );
    expect(r.output('a')).toMatchObject({ status: 'failure', usage: usage(10, 2), error: 'model is down' });
  });

  it('applies the token budget to failed blocks, even with continueOnError', async () => {
    const host = new FakeHost().agent('a', { error: new AgentRunError('model error', usage(90, 20)) });
    const r = await run(
      workflow([
        { id: 'a', type: 'agent', model: 'p/m', prompt: 'x', continueOnError: true },
        { id: 'never', type: 'console', run: 'x' },
      ]),
      { host, tokenBudget: 100 },
    );
    expect(r.summary.status).toBe('failure');
    expect(r.summary.error).toMatch(/^Token budget exceeded: used 110 of 100 tokens\./);
    expect(host.consoleCalls).toHaveLength(0);
  });

  it('stops retrying once the token budget is used up', async () => {
    const host = new FakeHost().agent('a', { error: new AgentRunError('bad JSON', usage(50, 10)) });
    const r = await run(
      workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x', retry: { max: 5 } }]),
      { host, tokenBudget: 100 },
    );
    expect(host.agentCalls).toHaveLength(2);
    expect(r.summary.usage).toEqual(usage(100, 20));
    expect(r.summary.error).toMatch(/^Token budget exceeded: used 120 of 100 tokens\./);
  });

  it('counts usage of an agent call that ends with an error after a cancel', async () => {
    const controller = new AbortController();
    const host = new FakeHost().agent('a', (_req, io) => {
      setTimeout(() => controller.abort(), 5);
      return new Promise((_resolve, reject) =>
        io.signal.addEventListener('abort', () =>
          reject(new AgentRunError('The agent run was cancelled.', usage(7, 3))),
        ),
      );
    });
    const r = await run(workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x' }]), {
      host,
      signal: controller.signal,
    });
    expect(r.summary.status).toBe('cancelled');
    expect(r.summary.usage).toEqual(usage(7, 3));
    expect(r.output('a')).toMatchObject({ status: 'cancelled', usage: usage(7, 3) });
  });

  it('ignores ordinary errors', async () => {
    const host = new FakeHost().agent('a', { error: Object.assign(new Error('x'), { usage: usage(5, 5) }) });
    const r = await run(workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x' }]), { host });
    expect(r.summary.usage).toEqual(usage(0, 0));
    expect(r.output('a')).not.toHaveProperty('usage');
  });
});
