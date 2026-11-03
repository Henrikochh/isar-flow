import { describe, expect, it } from 'vitest';
import type { AskStep, Step } from '../../src/schema/types';
import { eventsOfType, run, workflow } from '../engine/helpers';
import { FakeHost } from '../fakes/fakeHost';

const ask = (extra: Partial<AskStep> = {}): AskStep => ({
  id: 'pick',
  type: 'ask',
  question: 'Deploy to which environment?',
  ...extra,
});

/** The ask block followed by a console block that echoes its answer. */
const withEcho = (step: Step, extra: Step[] = []) =>
  workflow([step, ...extra, { id: 'use', type: 'console', run: 'echo ${{ steps.pick.answer }}' }]);

describe('ask block: answers', () => {
  it('asks the host with the rendered question and uses the answer', async () => {
    const host = new FakeHost().ask('pick', { answer: 'Make it faster' });
    const r = await run(withEcho(ask({ question: 'What about ${{ inputs.task }}?' })), {
      host,
      inputs: { task: 'the login form' },
    });
    expect(host.askCalls).toEqual([{ stepId: 'pick', question: 'What about the login form?' }]);
    expect(r.output('pick')).toEqual({
      answer: 'Make it faster',
      timedOut: false,
      status: 'success',
      durationMs: expect.any(Number),
    });
    expect(host.consoleCalls[0].command).toBe('echo Make it faster');
    expect(r.summary.status).toBe('success');
  });

  it('shows the rendered question as the step detail', async () => {
    const r = await run(withEcho(ask({ question: 'Ship ${{ inputs.v }}?' })), { inputs: { v: '1.2' } });
    expect(eventsOfType(r.events, 'step-start')[0]).toMatchObject({
      stepId: 'pick',
      stepType: 'ask',
      detail: 'Ship 1.2?',
    });
  });

  it('passes rendered choices, the default and the timeout to the host', async () => {
    const host = new FakeHost().ask('pick', { answer: 'prod' });
    const step = ask({
      choices: ['dev', '${{ inputs.second }}'],
      default: '${{ inputs.fallback }}',
      timeout: 90,
    });
    const r = await run(withEcho(step), { host, inputs: { second: 'prod', fallback: 'dev' } });
    expect(host.askCalls).toEqual([
      {
        stepId: 'pick',
        question: 'Deploy to which environment?',
        choices: ['dev', 'prod'],
        default: 'dev',
        timeoutMs: 90_000,
      },
    ]);
    expect(r.output('pick')?.answer).toBe('prod');
  });

  it('accepts a single choice', async () => {
    const host = new FakeHost().ask('pick', { answer: 'yes' });
    const r = await run(withEcho(ask({ choices: ['yes'] })), { host });
    expect(r.output('pick')?.answer).toBe('yes');
  });

  it('normalizes the spelling of an answer that matches a choice case-insensitively and trims it', async () => {
    const host = new FakeHost().ask('pick', { answer: '  PROD\n' });
    const r = await run(withEcho(ask({ choices: ['Dev', 'Prod'] })), { host });
    expect(r.output('pick')?.answer).toBe('Prod');
  });

  it('prefers the exact spelling when several choices differ only in case', async () => {
    const host = new FakeHost().ask('pick', { answer: 'dev' });
    const r = await run(withEcho(ask({ choices: ['DEV', 'dev'] })), { host });
    expect(r.output('pick')?.answer).toBe('dev');
  });

  it('fails when the answer is not one of the choices', async () => {
    const host = new FakeHost().ask('pick', { answer: 'staging' });
    const r = await run(withEcho(ask({ choices: ['dev', 'prod'] })), { host });
    expect(r.output('pick')).toMatchObject({
      status: 'failure',
      timedOut: false,
      error: "Answer 'staging' isn't one of the choices of 'pick': dev, prod.",
    });
    expect(r.summary.status).toBe('failure');
    expect(host.consoleCalls).toHaveLength(0);
  });

  it('trims free-text answers', async () => {
    const host = new FakeHost().ask('pick', { answer: '  Add tests  \n' });
    const r = await run(withEcho(ask()), { host });
    expect(r.output('pick')?.answer).toBe('Add tests');
  });

  it('uses the default for an empty answer', async () => {
    const host = new FakeHost().ask('pick', { answer: '   ' });
    const r = await run(withEcho(ask({ choices: ['dev', 'prod'], default: 'prod' })), { host });
    expect(r.output('pick')).toMatchObject({ status: 'success', answer: 'prod', timedOut: false });
    expect(r.trace).toContain("log:pick:info:Nobody answered; using the default 'prod'.\n");
  });

  it('fails on an empty answer without a default', async () => {
    for (const answer of ['', '  ', undefined, null]) {
      const host = new FakeHost().ask('pick', { answer: answer === undefined ? '' : answer });
      const r = await run(withEcho(ask()), { host });
      expect(r.output('pick')).toMatchObject({
        status: 'failure',
        error: "'pick' got an empty answer. Answer the question or give the block a default.",
      });
    }
  });

  it('reads answers that are not text the way templates print them', async () => {
    const host = new FakeHost().ask('pick', { answer: 2 });
    const r = await run(withEcho(ask({ choices: ['1', '2'] })), { host });
    expect(r.output('pick')?.answer).toBe('2');
  });

  it('fails with the host error when asking fails', async () => {
    const host = new FakeHost().ask('pick', { error: 'The question was dismissed.' });
    const r = await run(withEcho(ask()), { host });
    expect(r.output('pick')).toMatchObject({ status: 'failure', error: 'The question was dismissed.' });
  });
});

describe('ask block: choices and default', () => {
  it('drops choices that render to the same text, keeping the first', async () => {
    const host = new FakeHost().ask('pick', { answer: 'main' });
    const step = ask({ choices: ['main', '${{ inputs.branch }}', ' main ', 'dev'] });
    await run(withEcho(step), { host, inputs: { branch: 'main' } });
    expect(host.askCalls[0].choices).toEqual(['main', 'dev']);
  });

  it('fails before asking when a choice renders empty', async () => {
    const host = new FakeHost();
    const step = ask({ choices: ['dev', '${{ inputs.missing }}'], retry: { max: 3 } });
    const r = await run(withEcho(step), { host });
    expect(r.output('pick')).toMatchObject({
      status: 'failure',
      error: "Choice 2 of 'pick' is empty after its template was filled in.",
    });
    expect(host.askCalls).toHaveLength(0);
    expect(r.trace.filter((t) => t.startsWith('log:pick'))).toEqual([]);
  });

  it('fails before asking when the rendered default is not one of the choices', async () => {
    const host = new FakeHost();
    const step = ask({ choices: ['a', 'b'], default: '${{ inputs.d }}' });
    const r = await run(withEcho(step), { host, inputs: { d: 'x' } });
    expect(r.output('pick')).toMatchObject({
      status: 'failure',
      error: "The default 'x' of 'pick' isn't one of its choices: a, b.",
    });
    expect(host.askCalls).toHaveLength(0);
  });

  it('normalizes the spelling of a default that matches a choice case-insensitively', async () => {
    const host = new FakeHost();
    await run(withEcho(ask({ choices: ['Dev', 'Prod'], default: 'prod' })), { host });
    expect(host.askCalls[0].default).toBe('Prod');
  });

  it('treats a default that renders empty as no default', async () => {
    const host = new FakeHost().ask('pick', { answer: '' });
    const r = await run(withEcho(ask({ default: '${{ inputs.none }}' })), { host });
    expect(host.askCalls[0]).not.toHaveProperty('default');
    expect(r.output('pick')?.status).toBe('failure');
  });

  it('reports template errors in the question, a choice or the default as setup errors', async () => {
    const cases: [Partial<AskStep>, string][] = [
      [{ question: '${{ + }}' }, 'Expression error in question: '],
      [{ choices: ['a', '${{ + }}'] }, 'Expression error in choices[1]: '],
      [{ default: '${{ + }}' }, 'Expression error in default: '],
    ];
    for (const [extra, prefix] of cases) {
      const host = new FakeHost();
      const r = await run(withEcho(ask(extra)), { host });
      expect(r.error('pick')).toMatch(new RegExp(`^${prefix.replace(/[[\]]/g, '\\$&')}`));
      expect(host.askCalls).toHaveLength(0);
    }
  });
});

describe('ask block: nobody can answer', () => {
  it('uses the default without a host that can ask', async () => {
    const host = new FakeHost({ canAsk: false });
    const r = await run(withEcho(ask({ choices: ['dev', 'prod'], default: 'prod' })), { host });
    expect(r.output('pick')).toMatchObject({ status: 'success', answer: 'prod', timedOut: false });
    expect(r.trace).toContain("log:pick:info:Nobody can answer here; using the default 'prod'.\n");
    expect(host.consoleCalls[0].command).toBe('echo prod');
  });

  it('uses the first choice without a default', async () => {
    const host = new FakeHost({ canAsk: false });
    const r = await run(withEcho(ask({ choices: ['dev', 'prod'] })), { host });
    expect(r.output('pick')?.answer).toBe('dev');
    expect(r.trace).toContain("log:pick:info:Nobody can answer here; using the first choice 'dev'.\n");
  });

  it('fails without default and choices, and does not retry', async () => {
    const host = new FakeHost({ canAsk: false });
    const r = await run(withEcho(ask({ retry: { max: 2 } })), { host });
    expect(r.output('pick')).toMatchObject({
      status: 'failure',
      error: "Nobody can answer 'pick' here. Give it a default.",
    });
    expect(r.trace.filter((t) => t.includes('Retrying'))).toEqual([]);
  });
});

describe('ask block: timeout and cancellation', () => {
  it('uses the default when nobody answers in time', async () => {
    const host = new FakeHost().ask('pick', { hang: true });
    const r = await run(withEcho(ask({ choices: ['dev', 'prod'], default: 'dev', timeout: 0.05 })), { host });
    expect(r.output('pick')).toMatchObject({ status: 'success', answer: 'dev', timedOut: true });
    expect(r.trace).toContain("log:pick:info:No answer within 0.05s; using the default 'dev'.\n");
    expect(host.askCalls[0].timeoutMs).toBe(50);
    expect(host.calls[0].io.signal.aborted).toBe(true);
    expect(host.consoleCalls[0].command).toBe('echo dev');
    expect(r.summary.status).toBe('success');
  });

  it('uses the default when a host that ignores the abort never answers', async () => {
    const host = new FakeHost().ask('pick', { hang: true, ignoreAbort: true });
    const r = await run(withEcho(ask({ default: 'later', timeout: 0.02 })), { host });
    expect(r.output('pick')).toMatchObject({ status: 'success', answer: 'later', timedOut: true });
  });

  it('fails with timedOut when nobody answers in time and there is no default', async () => {
    const host = new FakeHost().ask('pick', { hang: true });
    const r = await run(withEcho(ask({ timeout: 0.05 })), { host });
    expect(r.output('pick')).toMatchObject({
      status: 'failure',
      timedOut: true,
      error: 'Timed out after 0.05s',
    });
    expect(r.summary.status).toBe('failure');
  });

  it('asks again on retry after a timeout without default', async () => {
    const host = new FakeHost().ask('pick', { hang: true }, { answer: 'second try' });
    const r = await run(withEcho(ask({ timeout: 0.05, retry: { max: 1 } })), { host });
    expect(host.askCalls).toHaveLength(2);
    expect(r.output('pick')).toMatchObject({ status: 'success', answer: 'second try', timedOut: false });
  });

  it('asks again on retry after an answer that is not a choice', async () => {
    const host = new FakeHost().ask('pick', { answer: 'staging' }, { answer: 'prod' });
    const r = await run(withEcho(ask({ choices: ['dev', 'prod'], retry: { max: 2 } })), { host });
    expect(host.askCalls).toHaveLength(2);
    expect(r.output('pick')?.answer).toBe('prod');
    expect(r.trace).toContain(
      "log:pick:info:Attempt 1 failed: Answer 'staging' isn't one of the choices of 'pick': dev, prod. Retrying (retry 1 of 2).\n",
    );
  });

  it('stays cancelled when the run is cancelled while asking, even with a default', async () => {
    const controller = new AbortController();
    const host = new FakeHost().ask('pick', () => {
      setTimeout(() => controller.abort(), 5);
      return { hang: true };
    });
    const r = await run(withEcho(ask({ default: 'dev', timeout: 60 })), { host, signal: controller.signal });
    expect(r.output('pick')).toMatchObject({ status: 'cancelled', error: 'Cancelled' });
    expect(r.output('pick')).not.toHaveProperty('answer');
    expect(r.summary.status).toBe('cancelled');
    expect(host.consoleCalls).toHaveLength(0);
  });

  it('cancels instead of using the default when an enclosing block times out', async () => {
    const host = new FakeHost().ask('pick', { hang: true });
    const outer: Step = {
      id: 'outer',
      type: 'loop',
      maxIterations: 1,
      timeout: 0.05,
      continueOnError: true,
      steps: [ask({ default: 'dev', timeout: 60 })],
    };
    const r = await run(workflow([outer]), { host });
    expect(r.output('pick')?.status).toBe('cancelled');
    expect(r.output('outer')).toMatchObject({ status: 'failure', error: 'Timed out after 0.05s' });
  });
});

describe('ask block: in loops and with continueOnError', () => {
  it('asks in every iteration and reads the latest answer', async () => {
    const host = new FakeHost().ask('pick', { answer: 'again' }, { answer: 'stop' });
    const r = await run(
      workflow([
        {
          id: 'chat',
          type: 'loop',
          maxIterations: 5,
          until: "steps.pick.answer == 'stop'",
          steps: [ask({ question: 'Round ${{ loop.iteration }}: continue?', choices: ['again', 'stop'] })],
        },
      ]),
      { host },
    );
    expect(host.askCalls.map((c) => c.question)).toEqual(['Round 1: continue?', 'Round 2: continue?']);
    expect(r.output('chat')).toMatchObject({ iterations: 2, exitReason: 'condition' });
  });

  it('lets later blocks read timedOut and the error of a failed ask', async () => {
    const host = new FakeHost().ask('pick', { hang: true });
    const r = await run(
      withEcho(ask({ timeout: 0.02, continueOnError: true }), [
        { id: 'why', type: 'console', run: '${{ steps.pick.timedOut }} ${{ steps.pick.error }}' },
      ]),
      { host },
    );
    expect(host.consoleCalls[0].command).toBe('true Timed out after 0.02s');
    expect(host.consoleCalls[1].command).toBe('echo ');
    expect(r.summary.status).toBe('success');
  });
});

describe('ask block: secrets', () => {
  const TOKEN = 'tok-1234567890';

  it('masks secrets in the question, the answer, logs and errors, but the host sees the real question', async () => {
    const host = new FakeHost().ask('pick', { answer: `use ${TOKEN}` }).ask('other', { answer: TOKEN });
    const r = await run(
      workflow([
        ask({ question: 'Token ${{ secrets.TOKEN }} ok?' }),
        { id: 'other', type: 'ask', question: 'Again?', choices: ['a'], continueOnError: true },
        { id: 'late', type: 'ask', question: 'Default?', default: '${{ secrets.TOKEN }}', timeout: 0.02 },
      ]),
      { host: host.ask('late', { hang: true }), secrets: { TOKEN } },
    );
    expect(host.askCalls[0].question).toBe(`Token ${TOKEN} ok?`);
    expect(eventsOfType(r.events, 'step-start')[0].detail).toBe('Token •••••• ok?');
    expect(r.output('pick')?.answer).toBe('use ••••••');
    expect(r.error('other')).toBe("Answer '••••••' isn't one of the choices of 'other': a.");
    expect(r.output('late')).toMatchObject({ answer: '••••••', timedOut: true });
    expect(JSON.stringify(r.events)).not.toContain(TOKEN);
    expect(JSON.stringify(r.summary)).not.toContain(TOKEN);
  });
});
