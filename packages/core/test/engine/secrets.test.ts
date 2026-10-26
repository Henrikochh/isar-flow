import { describe, expect, it } from 'vitest';
import { runWorkflow } from '../../src/engine';
import type { RunEvent, RunOptions, RunSummary } from '../../src/engine/types';
import type { Step } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, fakeClock, run, workflow } from './helpers';

const TOKEN = 's3cr3t-token';
const MASK = '••••••';
const secrets = { TOKEN, PIN: '123' };

describe('secret masking', () => {
  it('masks secrets in details, logs, errors, outputs, the run error and the summary', async () => {
    const host = new FakeHost()
      .console('call', {
        logs: [
          { stream: 'stdout', text: `using ${TOKEN}\n` },
          { stream: 'stderr', text: `denied for ${TOKEN}\n` },
        ],
        exitCode: 0,
        stdout: `token=${TOKEN}\n`,
      })
      .agent('ask', {
        text: `The key is ${TOKEN}`,
        json: { nested: { list: [`a ${TOKEN} b`, 7, true, null] } },
      })
      .console('fail', { error: `Authentication with ${TOKEN} failed` });
    const r = await run(
      workflow([
        { id: 'call', type: 'console', run: 'curl -H "Bearer ${{ secrets.TOKEN }}"' },
        { id: 'ask', type: 'agent', model: 'p/m', prompt: 'Use ${{ secrets.TOKEN }}' },
        { id: 'fail', type: 'console', run: 'x', continueOnError: true },
        { id: 'end', type: 'stop', message: 'Stopped with ${{ secrets.TOKEN }}' },
      ]),
      { host, secrets },
    );

    expect(JSON.stringify(r.events)).not.toContain(TOKEN);
    expect(JSON.stringify(r.summary)).not.toContain(TOKEN);
    const starts = eventsOfType(r.events, 'step-start');
    expect(starts.map((s) => s.detail)).toEqual([
      `curl -H "Bearer ${MASK}"`,
      `Use ${MASK}`,
      'x',
      `Stopped with ${MASK}`,
    ]);
    expect(eventsOfType(r.events, 'step-log').map((l) => l.text)).toEqual([
      `using ${MASK}\n`,
      `denied for ${MASK}\n`,
    ]);
    expect(r.output('call')?.stdout).toBe(`token=${MASK}\n`);
    expect(r.output('ask')).toMatchObject({
      text: `The key is ${MASK}`,
      json: { nested: { list: [`a ${MASK} b`, 7, true, null] } },
    });
    expect(r.error('fail')).toBe(`Authentication with ${MASK} failed`);
    expect(r.output('fail')?.error).toBe(`Authentication with ${MASK} failed`);
    expect(r.events.at(-1)).toMatchObject({ type: 'run-end', error: `Stopped with ${MASK}` });
    expect(r.summary.error).toBe(`Stopped with ${MASK}`);
    expect(r.summary.steps.ask.json).toEqual({ nested: { list: [`a ${MASK} b`, 7, true, null] } });
  });

  it('hands the real values to the host and to expressions', async () => {
    const host = new FakeHost().agent('ask', { text: `key ${TOKEN}` });
    const r = await run(
      workflow([
        { id: 'ask', type: 'agent', model: 'p/m', prompt: '${{ secrets.TOKEN }}' },
        { id: 'use', type: 'console', run: 'echo ${{ steps.ask.text }}' },
        { id: 'check', type: 'if', condition: "${{ steps.ask.text == 'key s3cr3t-token' }}", then: [] },
      ]),
      { host, secrets },
    );
    expect(host.agentCalls[0].prompt).toBe(TOKEN);
    expect(host.consoleCalls[0].command).toBe(`echo key ${TOKEN}`);
    expect(r.output('check')?.result).toBe(true);
    expect(eventsOfType(r.events, 'step-start')[1].detail).toBe(`echo key ${MASK}`);
  });

  it('leaves values shorter than four characters visible', async () => {
    const host = new FakeHost().console('a', { stdout: 'pin 123' });
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'echo ${{ secrets.PIN }}' }]), {
      host,
      secrets,
    });
    expect(eventsOfType(r.events, 'step-start')[0].detail).toBe('echo 123');
    expect(r.output('a')?.stdout).toBe('pin 123');
  });

  it('masks the longest secret first when one secret contains another', async () => {
    const host = new FakeHost().console('a', { stdout: 'x abcdefgh y abcd z' });
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), {
      host,
      secrets: { SHORT: 'abcd', LONG: 'abcdefgh' },
    });
    expect(r.output('a')?.stdout).toBe(`x ${MASK} y ${MASK} z`);
  });

  it('masks secrets that arrive split over several log chunks', async () => {
    const host = new FakeHost().agent('ask', {
      logs: [
        { stream: 'agent', text: 'The key is s3c' },
        { stream: 'agent', text: 'r3t-' },
        { stream: 'agent', text: 'token. Not s3' },
        { stream: 'agent', text: 'cret.' },
        { stream: 'agent', text: ' Ends with s3cr' },
      ],
    });
    const r = await run(workflow([{ id: 'ask', type: 'agent', model: 'p/m', prompt: 'p' }]), {
      host,
      secrets,
    });
    expect(eventsOfType(r.events, 'step-log').map((l) => l.text)).toEqual([
      'The key is ',
      `${MASK}. Not `,
      's3cret.',
      ' Ends with ',
      's3cr',
    ]);
    // Held-back text is written before the block ends.
    expect(r.trace.at(-2)).toBe('end:ask:success');
    expect(r.trace.at(-3)).toBe('log:ask:agent:s3cr');
  });

  it('keeps streams apart when holding back the start of a secret', async () => {
    const host = new FakeHost().console('a', {
      logs: [
        { stream: 'stdout', text: 'out s3cr3t' },
        { stream: 'stderr', text: '-token err\n' },
        { stream: 'stdout', text: '-token\n' },
      ],
    });
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { host, secrets });
    const text = (stream: string) =>
      eventsOfType(r.events, 'step-log')
        .filter((l) => l.stream === stream)
        .map((l) => l.text)
        .join('');
    expect(text('stdout')).toBe(`out ${MASK}\n`);
    expect(text('stderr')).toBe('-token err\n');
  });

  it('does not mask anything without secrets', async () => {
    const host = new FakeHost().console('a', { logs: [{ stream: 'stdout', text: 'abc' }], stdout: 'abc' });
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), { host });
    expect(r.trace).toContain('log:a:stdout:abc');
    expect(r.output('a')?.stdout).toBe('abc');
  });
});

describe('events are copies', () => {
  async function collect(
    steps: Step[],
    options: Partial<RunOptions>,
    onEvent: (event: RunEvent) => void,
  ): Promise<{ host: FakeHost; summary: RunSummary }> {
    const host = (options.host as FakeHost | undefined) ?? new FakeHost();
    const gen = runWorkflow(workflow(steps), {
      runId: 'run-1',
      inputs: {},
      agents: {},
      workspaceRoot: '/ws',
      now: fakeClock(),
      ...options,
      host,
    });
    let next = await gen.next();
    while (!next.done) {
      onEvent(next.value);
      next = await gen.next();
    }
    return { host, summary: next.value };
  }

  it('does not let listeners change outputs or inputs seen by expressions', async () => {
    const host = new FakeHost().agent('ask', { json: { verdict: { ok: true } } });
    const { summary } = await collect(
      [
        { id: 'ask', type: 'agent', model: 'p/m', prompt: 'p', output: { format: 'json' } },
        { id: 'use', type: 'console', run: '${{ steps.ask.json.verdict.ok }} ${{ inputs.list[0] }}' },
      ],
      { host, inputs: { list: ['first'] } },
      (event) => {
        if (event.type === 'run-start') (event.inputs.list as string[])[0] = 'changed';
        if (event.type === 'step-end' && event.stepId === 'ask') {
          (event.output.json as { verdict: { ok: boolean } }).verdict.ok = false;
          event.output.status = 'failure';
        }
      },
    );
    expect(host.consoleCalls[0].command).toBe('true first');
    expect(summary.steps.ask).toMatchObject({ status: 'success', json: { verdict: { ok: true } } });
  });

  it('does not share skipped outputs between events and the summary', async () => {
    const { summary } = await collect(
      [{ id: 'gate', type: 'if', condition: 'false', then: [{ id: 'never', type: 'break' }] }],
      {},
      (event) => {
        if (event.type === 'step-end' && event.stepId === 'never') event.output.status = 'failure';
      },
    );
    expect(summary.steps.never).toEqual({ status: 'skipped', durationMs: 0 });
  });
});
