import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'vscode';
import type { ApprovalPrompt, RunEvent } from '@isar-flow/core';
import { PendingApprovals } from '../../../src/editors/approvals';

function setup() {
  const requested = new EventEmitter<ApprovalPrompt & { workflowUri: string }>();
  const resolved = new EventEmitter<{ requestId: string; workflowUri: string }>();
  const events = new EventEmitter<{ workflowUri: string; event: RunEvent }>();
  const pending = new PendingApprovals({
    approvals: { onDidRequest: requested.event, onDidResolve: resolved.event },
    onEvent: events.event,
  });
  return { requested, resolved, events, pending };
}

const prompt = (requestId: string, workflowUri: string, runId = 'r1') => ({
  requestId,
  runId,
  stepId: 'gate',
  message: 'Ship it?',
  workflowUri,
});

describe('PendingApprovals', () => {
  it('lists open requests per workflow without the uri', () => {
    const { requested, pending } = setup();
    requested.fire(prompt('a', 'file:///w/one.workflow.yaml'));
    requested.fire(prompt('b', 'file:///w/two.workflow.yaml'));
    expect(pending.for('file:///w/one.workflow.yaml')).toEqual([
      { requestId: 'a', runId: 'r1', stepId: 'gate', message: 'Ship it?' },
    ]);
  });

  it('forgets answered requests', () => {
    const { requested, resolved, pending } = setup();
    requested.fire(prompt('a', 'file:///w/one.workflow.yaml'));
    resolved.fire({ requestId: 'a', workflowUri: 'file:///w/one.workflow.yaml' });
    expect(pending.for('file:///w/one.workflow.yaml')).toEqual([]);
  });

  it('forgets requests of runs that ended', () => {
    const { requested, events, pending } = setup();
    requested.fire(prompt('a', 'file:///w/one.workflow.yaml', 'r1'));
    requested.fire(prompt('b', 'file:///w/one.workflow.yaml', 'r2'));
    events.fire({
      workflowUri: 'file:///w/one.workflow.yaml',
      event: {
        type: 'run-end',
        runId: 'r1',
        status: 'cancelled',
        durationMs: 5,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    expect(pending.for('file:///w/one.workflow.yaml').map((p) => p.requestId)).toEqual(['b']);
  });

  it('stops listening when disposed', () => {
    const { requested, pending } = setup();
    pending.dispose();
    requested.fire(prompt('a', 'file:///w/one.workflow.yaml'));
    expect(pending.for('file:///w/one.workflow.yaml')).toEqual([]);
  });
});
