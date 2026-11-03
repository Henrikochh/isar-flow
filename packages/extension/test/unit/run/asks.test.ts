import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { AskPrompt } from '@isar-flow/core';
import { createAskBroker, type AskUi } from '../../../src/run/asks';
import { flush } from './fakes';

const URI = 'file:///ws/deploy.workflow.yaml';

const ask = (overrides: Partial<Omit<AskPrompt, 'requestId'>> = {}) => ({
  runId: 'run-1',
  stepId: 'target',
  question: 'Where to?',
  workflowUri: URI,
  workflowName: 'Deploy',
  ...overrides,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A UI whose notification answers come from `clicks` (in order); pickers answer with `pick` / `input`. */
function fakeUi(options: {
  clicks?: (string | undefined | Deferred<string | undefined>)[];
  pick?: (items: vscode.QuickPickItem[]) => string | undefined | Promise<string | undefined>;
  input?: (options: vscode.InputBoxOptions) => string | undefined | Promise<string | undefined>;
  now?: number;
}) {
  const clicks = [...(options.clicks ?? [])];
  const notices: { message: string; buttons: string[] }[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const picks: {
    items: vscode.QuickPickItem[];
    options: vscode.QuickPickOptions;
    token: vscode.CancellationToken;
  }[] = [];
  const inputs: { options: vscode.InputBoxOptions; token: vscode.CancellationToken }[] = [];
  const opened: string[] = [];
  const ui: AskUi = {
    notify: async (message, buttons) => {
      notices.push({ message, buttons });
      const next = clicks.shift();
      return typeof next === 'object' ? next.promise : next;
    },
    info: (message) => void infos.push(message),
    warn: (message) => void warnings.push(message),
    pick: async (items, pickOptions, token) => {
      picks.push({ items, options: pickOptions, token });
      const label = await options.pick?.(items);
      return items.find((item) => item.label === label);
    },
    input: async (inputOptions, token) => {
      inputs.push({ options: inputOptions, token });
      return options.input?.(inputOptions);
    },
    openWorkflow: async (uri) => void opened.push(uri),
    now: () => options.now ?? 1_000,
  };
  return { ui, notices, infos, warnings, picks, inputs, opened };
}

describe('createAskBroker', () => {
  it('shows an inline card in an attached editor and resolves with respond()', async () => {
    const { ui, notices } = fakeUi({});
    const broker = createAskBroker(ui);
    const requests: (AskPrompt & { workflowUri: string })[] = [];
    const resolved = vi.fn();
    broker.onDidRequest((r) => requests.push(r));
    broker.onDidResolve(resolved);
    broker.attach(URI);

    const answer = broker.request(ask({ choices: ['dev', 'prod'], default: 'dev', expiresAt: 5_000 }));
    await flush();
    expect(requests).toEqual([
      {
        requestId: expect.any(String),
        runId: 'run-1',
        stepId: 'target',
        question: 'Where to?',
        choices: ['dev', 'prod'],
        default: 'dev',
        expiresAt: 5_000,
        workflowUri: URI,
      },
    ]);
    expect(broker.pending(URI)).toEqual([expect.objectContaining({ requestId: requests[0].requestId })]);
    expect(broker.waiting('run-1')).toBe(true);

    broker.respond(requests[0].requestId, 'prod');
    expect(await answer).toEqual({ answer: 'prod' });
    expect(resolved).toHaveBeenCalledWith({ requestId: requests[0].requestId, workflowUri: URI });
    expect(broker.pending(URI)).toEqual([]);
    expect(broker.waiting('run-1')).toBe(false);
    expect(notices).toEqual([]);
  });

  it('ignores unknown requests and answers outside the choices, with a warning', async () => {
    const { ui, warnings } = fakeUi({});
    const broker = createAskBroker(ui);
    let requestId = '';
    broker.onDidRequest((r) => (requestId = r.requestId));
    broker.attach(URI);
    const answer = broker.request(ask({ choices: ['dev', 'prod'] }));
    await flush();

    broker.respond('nope', 'dev');
    broker.respond(requestId, 'staging');
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("isn't one of the choices");
    expect(broker.pending(URI)).toHaveLength(1);

    broker.respond(requestId, 'dev');
    broker.respond(requestId, 'prod');
    expect(await answer).toEqual({ answer: 'dev' });
  });

  it('accepts any text for questions without choices', async () => {
    const broker = createAskBroker(fakeUi({}).ui);
    let requestId = '';
    broker.onDidRequest((r) => (requestId = r.requestId));
    broker.attach(URI);
    const answer = broker.request(ask());
    await flush();
    broker.respond(requestId, 'somewhere else');
    expect(await answer).toEqual({ answer: 'somewhere else' });
  });

  it('asks with a notification and a QuickPick when no editor is attached', async () => {
    const { ui, notices, picks } = fakeUi({ clicks: ['Answer'], pick: () => 'prod' });
    const broker = createAskBroker(ui);
    const requested = vi.fn();
    broker.onDidRequest(requested);

    const answer = await broker.request(ask({ choices: ['dev', 'prod', 'test'], default: 'prod' }));
    expect(answer).toEqual({ answer: 'prod' });
    expect(notices).toEqual([{ message: 'Deploy asks: Where to?', buttons: ['Answer', 'Open workflow'] }]);
    expect(picks).toHaveLength(1);
    expect(picks[0].items).toEqual([
      { label: 'prod', description: 'Default' },
      { label: 'dev' },
      { label: 'test' },
    ]);
    expect(picks[0].options).toMatchObject({
      placeHolder: 'Where to?',
      ignoreFocusOut: true,
      title: 'Deploy asks',
    });
    expect(requested).not.toHaveBeenCalled();
  });

  it('asks with an InputBox for free text, prefilled with the default', async () => {
    const { ui, inputs } = fakeUi({ clicks: ['Answer'], input: () => 'qa' });
    const broker = createAskBroker(ui);
    expect(await broker.request(ask({ default: 'dev', expiresAt: 121_000 }))).toEqual({ answer: 'qa' });
    expect(inputs[0].options).toMatchObject({
      prompt: 'Where to?',
      value: 'dev',
      ignoreFocusOut: true,
      title: "Deploy asks. Answer within 2 min; then 'dev' is used.",
    });
    expect(inputs[0].options.validateInput).toBeUndefined();
  });

  it('requires a non-empty answer in the InputBox when there is no default', async () => {
    const { ui, inputs } = fakeUi({ clicks: ['Answer'], input: () => 'x' });
    const broker = createAskBroker(ui);
    await broker.request(ask({ expiresAt: 46_000 }));
    const validate = inputs[0].options.validateInput as (value: string) => string | undefined;
    expect(validate('  ')).toBe('Enter an answer.');
    expect(validate('ok')).toBeUndefined();
    expect(inputs[0].options.title).toBe('Deploy asks. Answer within 45 s; then the block fails.');
  });

  it('keeps the question open after Esc or a closed notification', async () => {
    const { ui, notices, picks } = fakeUi({ clicks: [undefined], pick: () => undefined });
    const broker = createAskBroker(ui);
    const answer = broker.request(ask({ choices: ['a', 'b'] }));
    await flush();
    expect(notices).toHaveLength(1);
    expect(broker.waiting('run-1')).toBe(true);

    expect(picks).toHaveLength(0);

    const escaped = fakeUi({ clicks: ['Answer'], pick: () => undefined });
    const second = createAskBroker(escaped.ui);
    const other = second.request(ask({ choices: ['a', 'b'] }));
    await flush();
    expect(escaped.picks).toHaveLength(1);
    expect(second.waiting('run-1')).toBe(true);

    broker.cancel('run-1');
    second.cancel('run-1');
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    await expect(other).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('opens the workflow from the notification and moves the question inline when an editor attaches', async () => {
    const { ui, opened } = fakeUi({ clicks: ['Open workflow'] });
    const broker = createAskBroker(ui);
    const requests: AskPrompt[] = [];
    broker.onDidRequest((r) => requests.push(r));
    const answer = broker.request(ask());
    await flush();
    expect(opened).toEqual([URI]);
    expect(requests).toEqual([]);

    broker.attach(URI);
    expect(requests).toHaveLength(1);
    expect(broker.isAttached(URI)).toBe(true);
    broker.respond(requests[0].requestId, 'here');
    expect(await answer).toEqual({ answer: 'here' });
  });

  it('turns inline questions back into a notification when the last editor detaches', async () => {
    const { ui, notices } = fakeUi({ clicks: [deferred<string | undefined>()] });
    const broker = createAskBroker(ui);
    const resolved = vi.fn();
    broker.onDidResolve(resolved);
    const first = broker.attach(URI);
    const second = broker.attach(URI);
    const answer = broker.request(ask());
    await flush();

    first.dispose();
    first.dispose();
    expect(notices).toEqual([]);
    second.dispose();
    expect(broker.isAttached(URI)).toBe(false);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(broker.pending(URI)).toEqual([]);
    await flush();
    expect(notices).toHaveLength(1);

    // An open notification is not shown twice when the editor comes and goes again.
    broker.attach(URI).dispose();
    await flush();
    expect(notices).toHaveLength(1);
    broker.dispose();
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('says a stale notification was already answered', async () => {
    const click = deferred<string | undefined>();
    const { ui, infos, picks } = fakeUi({ clicks: [click] });
    const broker = createAskBroker(ui);
    let requestId = '';
    broker.onDidRequest((r) => (requestId = r.requestId));
    const answer = broker.request(ask());
    await flush();
    broker.attach(URI);
    broker.respond(requestId, 'inline');
    expect(await answer).toEqual({ answer: 'inline' });

    click.resolve('Answer');
    await flush();
    expect(infos).toEqual(['This question was already answered.']);
    expect(picks).toEqual([]);
  });

  it('withdraws the question and closes the QuickPick when the signal aborts', async () => {
    const picked = deferred<string | undefined>();
    const { ui, picks } = fakeUi({ clicks: ['Answer'], pick: () => picked.promise });
    const broker = createAskBroker(ui);
    const controller = new AbortController();
    const answer = broker.request(ask({ choices: ['a', 'b'] }), controller.signal);
    await flush();
    expect(picks).toHaveLength(1);
    expect(picks[0].token.isCancellationRequested).toBe(false);

    controller.abort();
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    expect(picks[0].token.isCancellationRequested).toBe(true);
    expect(broker.waiting('run-1')).toBe(false);
    picked.resolve('a');
    await flush();

    const aborted = new AbortController();
    aborted.abort();
    await expect(broker.request(ask(), aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('withdraws inline questions on abort and keeps the reason as the message', async () => {
    const broker = createAskBroker(fakeUi({}).ui);
    const resolved = vi.fn();
    broker.onDidResolve(resolved);
    broker.attach(URI);
    const controller = new AbortController();
    const answer = broker.request(ask(), controller.signal);
    await flush();
    controller.abort(new Error('Timed out after 1 s'));
    await expect(answer).rejects.toMatchObject({ name: 'AbortError', message: 'Timed out after 1 s' });
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('cancels only the questions of one run', async () => {
    const broker = createAskBroker(fakeUi({}).ui);
    const ids: string[] = [];
    broker.onDidRequest((r) => ids.push(r.requestId));
    broker.attach(URI);
    const cancelled = broker.request(ask({ runId: 'run-1' }));
    const other = broker.request(ask({ runId: 'run-2' }));
    await flush();

    broker.cancel('run-1');
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    broker.respond(ids[1], 'fine');
    expect(await other).toEqual({ answer: 'fine' });
  });

  it('fires onDidChangeWaiting with the run id when questions open and close', async () => {
    const broker = createAskBroker(fakeUi({}).ui);
    const changed = vi.fn();
    broker.onDidChangeWaiting(changed);
    broker.attach(URI);
    let requestId = '';
    broker.onDidRequest((r) => (requestId = r.requestId));
    const answer = broker.request(ask());
    await flush();
    broker.respond(requestId, 'x');
    await answer;
    expect(changed.mock.calls).toEqual([['run-1'], ['run-1']]);
  });

  it('rejects everything on dispose', async () => {
    const broker = createAskBroker(fakeUi({}).ui);
    broker.attach(URI);
    const answer = broker.request(ask());
    await flush();
    broker.dispose();
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    expect(broker.isAttached(URI)).toBe(false);
  });
});
