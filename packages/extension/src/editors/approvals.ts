import type * as vscode from 'vscode';
import type { ApprovalPrompt } from '@isar-flow/core';
import type { ApprovalBroker, RunManager } from '../contracts';

type ApprovalSource = Pick<RunManager, 'onEvent'> & {
  approvals: Pick<ApprovalBroker, 'onDidRequest' | 'onDidResolve'>;
};

/**
 * Remembers unanswered approval requests so a workflow editor that opens (or reloads) during a run can show
 * them. The broker has no list of open requests; answered ones and those of ended runs are dropped.
 */
export class PendingApprovals implements vscode.Disposable {
  private readonly pending = new Map<string, ApprovalPrompt & { workflowUri: string }>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(runs: ApprovalSource) {
    this.subscriptions = [
      runs.approvals.onDidRequest((prompt) => this.pending.set(prompt.requestId, prompt)),
      runs.approvals.onDidResolve(({ requestId }) => this.pending.delete(requestId)),
      runs.onEvent(({ event }) => {
        if (event.type !== 'run-end') return;
        for (const [id, prompt] of this.pending) if (prompt.runId === event.runId) this.pending.delete(id);
      }),
    ];
  }

  for(workflowUri: string): ApprovalPrompt[] {
    return [...this.pending.values()]
      .filter((prompt) => prompt.workflowUri === workflowUri)
      .map(({ workflowUri: _uri, ...prompt }) => prompt);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.pending.clear();
  }
}
