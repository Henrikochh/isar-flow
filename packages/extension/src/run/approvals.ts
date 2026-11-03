import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApprovalPrompt, ApprovalResult } from '@isar-flow/core';
import type { ApprovalBroker } from '../contracts';
import { createAttachments } from './attachments';
import { OPEN_WORKFLOW_BUTTON, openWorkflowEditor } from './notices';

/** Window access of the approval broker, injectable for tests. */
export interface ApprovalUi {
  /** Non-modal notification; resolves with the clicked button, or undefined once it is closed. */
  notify(message: string, buttons: string[]): Thenable<string | undefined>;
  info(message: string): void;
  openWorkflow(workflowUri: string): Thenable<unknown>;
}

export interface RunApprovalBroker extends ApprovalBroker, vscode.Disposable {
  /**
   * Like ApprovalBroker.request; aborting `signal` (step timeout, cancel) resolves the request as rejected.
   * `workflowName` names the workflow in the notification.
   */
  request(
    prompt: Omit<ApprovalPrompt, 'requestId'> & { workflowUri: string; workflowName?: string },
    signal?: AbortSignal,
  ): Promise<ApprovalResult>;
  /** Prompts of this workflow still waiting for an inline answer (for editors that become visible again). */
  pending(workflowUri: string): ApprovalPrompt[];
  /** Resolves the open requests of a run as rejected (the run was cancelled or has ended). */
  cancel(runId: string): void;
  /** Whether a workflow editor of the workflow is attached (visible). */
  isAttached(workflowUri: string): boolean;
  /** Whether the run waits for an approval (the run's status bar item says so). */
  waiting(runId: string): boolean;
  /** Fired with the run id when one of its approvals opens or closes. */
  readonly onDidChangeWaiting: vscode.Event<string>;
}

interface PendingRequest {
  prompt: ApprovalPrompt;
  workflowUri: string;
  workflowName?: string;
  /** True while the request is shown in workflow editors rather than in a notification. */
  inline: boolean;
  noticeOpen: boolean;
  resolve(result: ApprovalResult): void;
}

export const APPROVE_BUTTON = 'Approve';
export const REJECT_BUTTON = 'Reject';
export const APPROVAL_ALREADY_ANSWERED = 'This approval was already answered.';

const vscodeUi: ApprovalUi = {
  notify: (message, buttons) => vscode.window.showWarningMessage(message, ...buttons),
  info: (message) => void vscode.window.showInformationMessage(message),
  openWorkflow: openWorkflowEditor,
};

const REJECTED: ApprovalResult = { approved: false };

/**
 * Approval blocks: inline prompts in attached workflow editors; otherwise a notification with Approve, Reject and
 * Open workflow. Closing the notification keeps the request open until the block times out, the run ends or an
 * editor of the workflow answers it.
 */
export function createApprovalBroker(overrides: Partial<ApprovalUi> = {}): RunApprovalBroker {
  const ui: ApprovalUi = { ...vscodeUi, ...overrides };
  const onDidRequest = new vscode.EventEmitter<ApprovalPrompt & { workflowUri: string }>();
  const onDidResolve = new vscode.EventEmitter<{ requestId: string; workflowUri: string }>();
  const onDidChangeWaiting = new vscode.EventEmitter<string>();
  const pending = new Map<string, PendingRequest>();

  const settle = (requestId: string, result: ApprovalResult) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    if (entry.inline) onDidResolve.fire({ requestId, workflowUri: entry.workflowUri });
    onDidChangeWaiting.fire(entry.prompt.runId);
    entry.resolve(result);
  };

  const showInline = (entry: PendingRequest) => {
    entry.inline = true;
    onDidRequest.fire({ ...entry.prompt, workflowUri: entry.workflowUri });
  };

  const showNotice = (entry: PendingRequest) => {
    entry.inline = false;
    if (entry.noticeOpen) return;
    entry.noticeOpen = true;
    const { requestId, message } = entry.prompt;
    const text = entry.workflowName
      ? `${entry.workflowName} needs your approval: ${message}`
      : `Approval needed: ${message}`;
    ui.notify(text, [APPROVE_BUTTON, REJECT_BUTTON, OPEN_WORKFLOW_BUTTON]).then(
      (choice) => {
        entry.noticeOpen = false;
        if (choice === undefined) return;
        if (pending.get(requestId) !== entry) {
          ui.info(APPROVAL_ALREADY_ANSWERED);
          return;
        }
        if (choice === APPROVE_BUTTON) settle(requestId, { approved: true });
        else if (choice === REJECT_BUTTON) settle(requestId, REJECTED);
        else if (choice === OPEN_WORKFLOW_BUTTON) {
          void Promise.resolve(ui.openWorkflow(entry.workflowUri)).catch(() => undefined);
        }
      },
      () => {
        entry.noticeOpen = false;
      },
    );
  };

  const attachments = createAttachments(
    (workflowUri) => {
      for (const entry of pending.values()) {
        if (entry.workflowUri === workflowUri && !entry.inline) showInline(entry);
      }
    },
    (workflowUri) => {
      for (const entry of [...pending.values()]) {
        if (entry.workflowUri !== workflowUri || !entry.inline) continue;
        onDidResolve.fire({ requestId: entry.prompt.requestId, workflowUri });
        showNotice(entry);
      }
    },
  );

  return {
    onDidRequest: onDidRequest.event,
    onDidResolve: onDidResolve.event,
    onDidChangeWaiting: onDidChangeWaiting.event,

    request({ workflowUri, workflowName, ...rest }, signal) {
      const prompt: ApprovalPrompt = { ...rest, requestId: `approval-${randomUUID()}` };
      if (signal?.aborted) return Promise.resolve(REJECTED);
      return new Promise<ApprovalResult>((resolve) => {
        const onAbort = () => settle(prompt.requestId, REJECTED);
        signal?.addEventListener('abort', onAbort, { once: true });
        const entry: PendingRequest = {
          prompt,
          workflowUri,
          ...(workflowName !== undefined && { workflowName }),
          inline: false,
          noticeOpen: false,
          resolve: (result) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
          },
        };
        pending.set(prompt.requestId, entry);
        onDidChangeWaiting.fire(prompt.runId);
        if (attachments.isAttached(workflowUri)) showInline(entry);
        else showNotice(entry);
      });
    },

    respond(requestId, result) {
      settle(requestId, result);
    },

    attach: (workflowUri) => attachments.attach(workflowUri),
    isAttached: (workflowUri) => attachments.isAttached(workflowUri),

    pending(workflowUri) {
      return [...pending.values()]
        .filter((entry) => entry.inline && entry.workflowUri === workflowUri)
        .map((entry) => ({ ...entry.prompt }));
    },

    waiting: (runId) => [...pending.values()].some((entry) => entry.prompt.runId === runId),

    cancel(runId) {
      for (const entry of [...pending.values()]) {
        if (entry.prompt.runId === runId) settle(entry.prompt.requestId, REJECTED);
      }
    },

    dispose() {
      for (const requestId of [...pending.keys()]) settle(requestId, REJECTED);
      attachments.clear();
      onDidRequest.dispose();
      onDidResolve.dispose();
      onDidChangeWaiting.dispose();
    },
  };
}
