import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApprovalPrompt, ApprovalResult } from '@isar-flow/core';
import type { ApprovalBroker } from '../contracts';

export interface ApprovalUi {
  /** Asks with a modal dialog; resolves true for Approve. */
  modal(message: string): Promise<boolean>;
}

export interface RunApprovalBroker extends ApprovalBroker, vscode.Disposable {
  /** Like ApprovalBroker.request; aborting `signal` (step timeout, cancel) resolves the request as rejected. */
  request(
    prompt: Omit<ApprovalPrompt, 'requestId'> & { workflowUri: string },
    signal?: AbortSignal,
  ): Promise<ApprovalResult>;
  /** Prompts of this workflow still waiting for an inline answer (for editors that become visible again). */
  pending(workflowUri: string): ApprovalPrompt[];
  /** Resolves the open requests of a run as rejected (the run was cancelled or has ended). */
  cancel(runId: string): void;
}

interface PendingRequest {
  prompt: ApprovalPrompt;
  workflowUri: string;
  /** True while the request is shown in workflow editors rather than in a modal. */
  inline: boolean;
  resolve(result: ApprovalResult): void;
}

export const APPROVE_BUTTON = 'Approve';
export const REJECT_BUTTON = 'Reject';

const modalUi: ApprovalUi = {
  async modal(message) {
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      APPROVE_BUTTON,
      REJECT_BUTTON,
    );
    return choice === APPROVE_BUTTON;
  },
};

const REJECTED: ApprovalResult = { approved: false };

export function createApprovalBroker(ui: ApprovalUi = modalUi): RunApprovalBroker {
  const onDidRequest = new vscode.EventEmitter<ApprovalPrompt & { workflowUri: string }>();
  const onDidResolve = new vscode.EventEmitter<{ requestId: string; workflowUri: string }>();
  const attached = new Map<string, number>();
  const pending = new Map<string, PendingRequest>();

  const settle = (requestId: string, result: ApprovalResult) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    if (entry.inline) onDidResolve.fire({ requestId, workflowUri: entry.workflowUri });
    entry.resolve(result);
  };

  const askWithModal = (entry: PendingRequest) => {
    entry.inline = false;
    const { requestId, message } = entry.prompt;
    ui.modal(`Approval needed: ${message}`).then(
      (approved) => settle(requestId, { approved }),
      () => settle(requestId, REJECTED),
    );
  };

  /** Requests shown in editors of a workflow that no longer has a visible editor are asked in a modal instead. */
  const detached = (workflowUri: string) => {
    for (const entry of [...pending.values()]) {
      if (entry.workflowUri !== workflowUri || !entry.inline) continue;
      onDidResolve.fire({ requestId: entry.prompt.requestId, workflowUri });
      askWithModal(entry);
    }
  };

  return {
    onDidRequest: onDidRequest.event,
    onDidResolve: onDidResolve.event,

    request({ workflowUri, ...rest }, signal) {
      const prompt: ApprovalPrompt = { ...rest, requestId: `approval-${randomUUID()}` };
      if (signal?.aborted) return Promise.resolve(REJECTED);
      return new Promise<ApprovalResult>((resolve) => {
        const onAbort = () => settle(prompt.requestId, REJECTED);
        signal?.addEventListener('abort', onAbort, { once: true });
        const entry: PendingRequest = {
          prompt,
          workflowUri,
          inline: false,
          resolve: (result) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
          },
        };
        pending.set(prompt.requestId, entry);
        if ((attached.get(workflowUri) ?? 0) > 0) {
          entry.inline = true;
          onDidRequest.fire({ ...prompt, workflowUri });
        } else {
          askWithModal(entry);
        }
      });
    },

    respond(requestId, result) {
      settle(requestId, result);
    },

    attach(workflowUri) {
      attached.set(workflowUri, (attached.get(workflowUri) ?? 0) + 1);
      let disposed = false;
      return new vscode.Disposable(() => {
        if (disposed) return;
        disposed = true;
        const count = (attached.get(workflowUri) ?? 1) - 1;
        if (count > 0) {
          attached.set(workflowUri, count);
          return;
        }
        attached.delete(workflowUri);
        detached(workflowUri);
      });
    },

    pending(workflowUri) {
      return [...pending.values()]
        .filter((entry) => entry.inline && entry.workflowUri === workflowUri)
        .map((entry) => ({ ...entry.prompt }));
    },

    cancel(runId) {
      for (const entry of [...pending.values()]) {
        if (entry.prompt.runId === runId) settle(entry.prompt.requestId, REJECTED);
      }
    },

    dispose() {
      for (const requestId of [...pending.keys()]) settle(requestId, REJECTED);
      attached.clear();
      onDidRequest.dispose();
      onDidResolve.dispose();
    },
  };
}
