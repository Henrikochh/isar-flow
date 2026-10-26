import { describe, expect, it, vi } from 'vitest';
import type { ApprovalPrompt } from '@isar-flow/core';
import { createApprovalBroker } from '../../../src/run/approvals';
import { flush } from './fakes';

const URI = 'file:///ws/review.workflow.yaml';
const prompt = (runId = 'run-1') => ({ runId, stepId: 'gate', message: 'Ship it?', workflowUri: URI });

describe('createApprovalBroker', () => {
  it('asks with a modal when no editor is attached', async () => {
    const modal = vi.fn(async () => true);
    const broker = createApprovalBroker({ modal });
    const requested = vi.fn();
    broker.onDidRequest(requested);

    expect(await broker.request(prompt())).toEqual({ approved: true });
    expect(modal).toHaveBeenCalledTimes(1);
    expect((modal.mock.calls[0] as unknown as [string])[0]).toContain('Ship it?');
    expect(requested).not.toHaveBeenCalled();
  });

  it('treats a dismissed modal as a rejection', async () => {
    const broker = createApprovalBroker({ modal: async () => false });
    expect(await broker.request(prompt())).toEqual({ approved: false });
  });

  it('routes to attached editors and waits for respond()', async () => {
    const modal = vi.fn(async () => true);
    const broker = createApprovalBroker({ modal });
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

    broker.respond(requests[0].requestId, { approved: false, comment: 'Not yet' });
    expect(await result).toEqual({ approved: false, comment: 'Not yet' });
    expect(resolved).toHaveBeenCalledWith({ requestId: requests[0].requestId, workflowUri: URI });
    expect(modal).not.toHaveBeenCalled();
  });

  it('only routes inline to editors of the same workflow', async () => {
    const modal = vi.fn(async () => true);
    const broker = createApprovalBroker({ modal });
    broker.attach('file:///ws/other.workflow.yaml');
    expect(await broker.request(prompt())).toEqual({ approved: true });
    expect(modal).toHaveBeenCalled();
  });

  it('counts attachments per workflow', async () => {
    const modal = vi.fn(async () => true);
    const broker = createApprovalBroker({ modal });
    const requested = vi.fn((r: { requestId: string }) => r.requestId);
    broker.onDidRequest(requested);
    const first = broker.attach(URI);
    const second = broker.attach(URI);
    first.dispose();
    first.dispose();

    const inline = broker.request(prompt());
    await flush();
    expect(requested).toHaveBeenCalledTimes(1);
    expect(modal).not.toHaveBeenCalled();
    broker.respond(requested.mock.results[0].value as string, { approved: true });
    await inline;

    second.dispose();
    await broker.request(prompt('run-2'));
    expect(modal).toHaveBeenCalledTimes(1);
  });

  it('falls back to the modal when the last editor detaches while a request is pending', async () => {
    const modal = vi.fn(async () => true);
    const broker = createApprovalBroker({ modal });
    const resolved = vi.fn();
    broker.onDidResolve(resolved);
    const attachment = broker.attach(URI);
    const result = broker.request(prompt());
    await flush();

    attachment.dispose();
    expect(await result).toEqual({ approved: true });
    expect(modal).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('lists pending prompts so a re-opened editor can show them', async () => {
    const broker = createApprovalBroker({ modal: async () => true });
    broker.attach(URI);
    void broker.request(prompt());
    await flush();
    expect(broker.pending(URI)).toEqual([expect.objectContaining({ runId: 'run-1', message: 'Ship it?' })]);
    expect(broker.pending('file:///else')).toEqual([]);
  });

  it('ignores unknown and repeated responses', async () => {
    const broker = createApprovalBroker({ modal: async () => true });
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
    const broker = createApprovalBroker({ modal: async () => true });
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

  it('rejects modal requests of a cancelled run without waiting for the dialog', async () => {
    const broker = createApprovalBroker({ modal: () => new Promise<boolean>(() => undefined) });
    const result = broker.request(prompt());
    await flush();
    broker.cancel('run-1');
    expect(await result).toEqual({ approved: false });
  });

  it('rejects a request when its signal aborts', async () => {
    const broker = createApprovalBroker({ modal: async () => true });
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

  it('rejects everything pending on dispose', async () => {
    const broker = createApprovalBroker({ modal: async () => true });
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
