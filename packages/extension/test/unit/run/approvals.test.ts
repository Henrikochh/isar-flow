import { describe, expect, it, vi } from 'vitest';
import type { ApprovalPrompt } from '@isar-flow/core';
import { createApprovalBroker, type ApprovalUi } from '../../../src/run/approvals';
import { flush } from './fakes';

const URI = 'file:///ws/review.workflow.yaml';
const prompt = (runId = 'run-1') => ({
  runId,
  stepId: 'gate',
  message: 'Ship it?',
  workflowUri: URI,
  workflowName: 'Review',
});

/** Notifications answer with `clicks` in order (a promise stays open until resolved). */
function fakeUi(clicks: (string | undefined | Promise<string | undefined>)[] = []) {
  const queue = [...clicks];
  const notices: { message: string; buttons: string[] }[] = [];
  const infos: string[] = [];
  const opened: string[] = [];
  const ui: ApprovalUi = {
    notify: vi.fn(async (message: string, buttons: string[]) => {
      notices.push({ message, buttons });
      return queue.shift();
    }),
    info: (message) => void infos.push(message),
    openWorkflow: async (uri) => void opened.push(uri),
  };
  return { ui, notices, infos, opened };
}

describe('createApprovalBroker', () => {
  it('asks with a notification when no editor is attached', async () => {
    const { ui, notices } = fakeUi(['Approve']);
    const broker = createApprovalBroker(ui);
    const requested = vi.fn();
    broker.onDidRequest(requested);

    expect(await broker.request(prompt())).toEqual({ approved: true });
    expect(notices).toEqual([
      { message: 'Review needs your approval: Ship it?', buttons: ['Approve', 'Reject', 'Open workflow'] },
    ]);
    expect(requested).not.toHaveBeenCalled();
  });

  it('rejects with the Reject button and names no workflow when the name is unknown', async () => {
    const { ui, notices } = fakeUi(['Reject']);
    const broker = createApprovalBroker(ui);
    const { workflowName: _name, ...unnamed } = prompt();
    expect(await broker.request(unnamed)).toEqual({ approved: false });
    expect(notices[0].message).toBe('Approval needed: Ship it?');
  });

  it('keeps the request open when the notification is closed', async () => {
    const { ui } = fakeUi([undefined]);
    const broker = createApprovalBroker(ui);
    const result = broker.request(prompt());
    await flush();
    expect(broker.waiting('run-1')).toBe(true);
    broker.cancel('run-1');
    expect(await result).toEqual({ approved: false });
    expect(broker.waiting('run-1')).toBe(false);
  });

  it('opens the workflow and moves the request inline when an editor attaches', async () => {
    const { ui, opened } = fakeUi(['Open workflow']);
    const broker = createApprovalBroker(ui);
    const requests: ApprovalPrompt[] = [];
    broker.onDidRequest((r) => requests.push(r));
    const result = broker.request(prompt());
    await flush();
    expect(opened).toEqual([URI]);

    broker.attach(URI);
    expect(requests).toHaveLength(1);
    expect(broker.pending(URI)).toHaveLength(1);
    broker.respond(requests[0].requestId, { approved: true, comment: 'Go' });
    expect(await result).toEqual({ approved: true, comment: 'Go' });
  });

  it('says a stale notification was already answered', async () => {
    let click!: (value: string | undefined) => void;
    const { ui, infos } = fakeUi([new Promise<string | undefined>((resolve) => (click = resolve))]);
    const broker = createApprovalBroker(ui);
    let requestId = '';
    broker.onDidRequest((r) => (requestId = r.requestId));
    const result = broker.request(prompt());
    await flush();
    broker.attach(URI);
    broker.respond(requestId, { approved: false });
    expect(await result).toEqual({ approved: false });

    click('Approve');
    await flush();
    expect(infos).toEqual(['This approval was already answered.']);
  });

  it('routes to attached editors and waits for respond()', async () => {
    const { ui, notices } = fakeUi();
    const broker = createApprovalBroker(ui);
    const requests: (ApprovalPrompt & { workflowUri: string })[] = [];
    const resolved = vi.fn();
    broker.onDidRequest((r) => requests.push(r));
    broker.onDidResolve(resolved);
    broker.attach(URI);

    const result = broker.request(prompt());
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      runId: 'run-1',
      stepId: 'gate',
      message: 'Ship it?',
      workflowUri: URI,
    });
    expect(requests[0].requestId).toEqual(expect.any(String));
    expect(broker.isAttached(URI)).toBe(true);

    broker.respond(requests[0].requestId, { approved: false, comment: 'Not yet' });
    expect(await result).toEqual({ approved: false, comment: 'Not yet' });
    expect(resolved).toHaveBeenCalledWith({ requestId: requests[0].requestId, workflowUri: URI });
    expect(notices).toEqual([]);
  });

  it('only routes inline to editors of the same workflow', async () => {
    const { ui, notices } = fakeUi(['Approve']);
    const broker = createApprovalBroker(ui);
    broker.attach('file:///ws/other.workflow.yaml');
    expect(await broker.request(prompt())).toEqual({ approved: true });
    expect(notices).toHaveLength(1);
  });

  it('counts attachments per workflow', async () => {
    const { ui, notices } = fakeUi(['Approve']);
    const broker = createApprovalBroker(ui);
    const requested = vi.fn((r: { requestId: string }) => r.requestId);
    broker.onDidRequest(requested);
    const first = broker.attach(URI);
    const second = broker.attach(URI);
    first.dispose();
    first.dispose();

    const inline = broker.request(prompt());
    await flush();
    expect(requested).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
    broker.respond(requested.mock.results[0].value as string, { approved: true });
    await inline;

    second.dispose();
    expect(broker.isAttached(URI)).toBe(false);
    await broker.request(prompt('run-2'));
    expect(notices).toHaveLength(1);
  });

  it('falls back to a notification when the last editor detaches while a request is pending', async () => {
    const { ui, notices } = fakeUi(['Approve']);
    const broker = createApprovalBroker(ui);
    const resolved = vi.fn();
    broker.onDidResolve(resolved);
    const attachment = broker.attach(URI);
    const result = broker.request(prompt());
    await flush();

    attachment.dispose();
    expect(await result).toEqual({ approved: true });
    expect(notices).toHaveLength(1);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('lists pending prompts so a re-opened editor can show them', async () => {
    const broker = createApprovalBroker(fakeUi().ui);
    broker.attach(URI);
    void broker.request(prompt());
    await flush();
    expect(broker.pending(URI)).toEqual([expect.objectContaining({ runId: 'run-1', message: 'Ship it?' })]);
    expect(broker.pending('file:///else')).toEqual([]);
  });

  it('ignores unknown and repeated responses', async () => {
    const broker = createApprovalBroker(fakeUi().ui);
    let requestId = '';
    broker.onDidRequest((r) => (requestId = r.requestId));
    broker.attach(URI);
    const result = broker.request(prompt());
    await flush();
    broker.respond('nope', { approved: false });
    broker.respond(requestId, { approved: true });
    broker.respond(requestId, { approved: false });
    expect(await result).toEqual({ approved: true });
  });

  it('rejects the pending requests of a cancelled run only', async () => {
    const broker = createApprovalBroker(fakeUi().ui);
    const ids: string[] = [];
    broker.onDidRequest((r) => ids.push(r.requestId));
    broker.attach(URI);
    const cancelled = broker.request(prompt('run-1'));
    const other = broker.request(prompt('run-2'));
    await flush();

    broker.cancel('run-1');
    expect(await cancelled).toEqual({ approved: false });
    broker.respond(ids[1], { approved: true });
    expect(await other).toEqual({ approved: true });
  });

  it('rejects notification requests of a cancelled run without waiting for a click', async () => {
    const broker = createApprovalBroker(fakeUi([new Promise<string | undefined>(() => undefined)]).ui);
    const result = broker.request(prompt());
    await flush();
    broker.cancel('run-1');
    expect(await result).toEqual({ approved: false });
  });

  it('rejects a request when its signal aborts', async () => {
    const broker = createApprovalBroker(fakeUi().ui);
    const resolved = vi.fn();
    broker.onDidResolve(resolved);
    broker.attach(URI);
    const controller = new AbortController();
    const result = broker.request(prompt(), controller.signal);
    await flush();
    controller.abort();
    expect(await result).toEqual({ approved: false });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(broker.pending(URI)).toEqual([]);

    const aborted = new AbortController();
    aborted.abort();
    expect(await broker.request(prompt(), aborted.signal)).toEqual({ approved: false });
  });

  it('fires onDidChangeWaiting when requests open and close', async () => {
    const broker = createApprovalBroker(fakeUi().ui);
    const changed = vi.fn();
    broker.onDidChangeWaiting(changed);
    broker.attach(URI);
    const result = broker.request(prompt());
    await flush();
    broker.cancel('run-1');
    await result;
    expect(changed.mock.calls).toEqual([['run-1'], ['run-1']]);
  });

  it('rejects everything pending on dispose', async () => {
    const broker = createApprovalBroker(fakeUi().ui);
    const resolved = vi.fn();
    broker.onDidResolve(resolved);
    broker.attach(URI);
    const result = broker.request(prompt());
    await flush();
    broker.dispose();
    expect(await result).toEqual({ approved: false });
    expect(resolved).toHaveBeenCalledTimes(1);
  });
});
