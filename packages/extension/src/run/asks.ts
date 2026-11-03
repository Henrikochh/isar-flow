import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { AskPrompt, AskResult } from '@isar-flow/core';
import type { AskBroker } from '../contracts';
import { createAttachments } from './attachments';
import { abortError, formatTimeLeft, OPEN_WORKFLOW_BUTTON, openWorkflowEditor } from './notices';

/** Window access of the ask broker, injectable for tests. */
export interface AskUi {
  /** Non-modal notification; resolves with the clicked button, or undefined once it is closed. */
  notify(message: string, buttons: string[]): Thenable<string | undefined>;
  info(message: string): void;
  warn(message: string): void;
  pick(
    items: vscode.QuickPickItem[],
    options: vscode.QuickPickOptions,
    token: vscode.CancellationToken,
  ): Thenable<vscode.QuickPickItem | undefined>;
  input(options: vscode.InputBoxOptions, token: vscode.CancellationToken): Thenable<string | undefined>;
  openWorkflow(workflowUri: string): Thenable<unknown>;
  now(): number;
}

export type AskRequestPrompt = Omit<AskPrompt, 'requestId'> & { workflowUri: string; workflowName: string };

export interface RunAskBroker extends AskBroker, vscode.Disposable {
  /** Whether a workflow editor of the workflow is attached (visible). */
  isAttached(workflowUri: string): boolean;
  /** Whether the run has an open question (the run's status bar item says so). */
  waiting(runId: string): boolean;
  /** Fired with the run id when one of its questions opens or closes. */
  readonly onDidChangeWaiting: vscode.Event<string>;
}

export const ANSWER_BUTTON = 'Answer';
export const ALREADY_ANSWERED = 'This question was already answered.';

const vscodeUi: AskUi = {
  notify: (message, buttons) => vscode.window.showInformationMessage(message, ...buttons),
  info: (message) => void vscode.window.showInformationMessage(message),
  warn: () => undefined,
  pick: (items, options, token) => vscode.window.showQuickPick(items, options, token),
  input: (options, token) => vscode.window.showInputBox(options, token),
  openWorkflow: openWorkflowEditor,
  now: Date.now,
};

interface PendingAsk {
  prompt: AskPrompt;
  workflowUri: string;
  workflowName: string;
  /** Shown as a card in attached editors rather than as a notification. */
  inline: boolean;
  noticeOpen: boolean;
  /** Closes an open QuickPick or InputBox. */
  picker?: vscode.CancellationTokenSource;
  settle(outcome: { answer: string } | { error: Error }): void;
}

/**
 * Questions of ask blocks. Inline cards in attached workflow editors; otherwise a notification whose Answer button
 * opens a QuickPick (choices) or an InputBox (free text). Closing either keeps the question open until the block
 * times out, the run ends or an editor of the workflow answers it.
 */
export function createAskBroker(overrides: Partial<AskUi> = {}): RunAskBroker {
  const ui: AskUi = { ...vscodeUi, ...overrides };
  const onDidRequest = new vscode.EventEmitter<AskPrompt & { workflowUri: string }>();
  const onDidResolve = new vscode.EventEmitter<{ requestId: string; workflowUri: string }>();
  const onDidChangeWaiting = new vscode.EventEmitter<string>();
  const pending = new Map<string, PendingAsk>();

  const showInline = (entry: PendingAsk) => {
    entry.inline = true;
    onDidRequest.fire({ ...entry.prompt, workflowUri: entry.workflowUri });
  };

  const timeHint = ({ prompt }: PendingAsk): string | undefined => {
    if (prompt.expiresAt === undefined) return undefined;
    const left = prompt.expiresAt - ui.now();
    if (left <= 0) return undefined;
    const then = prompt.default === undefined ? 'the block fails' : `'${prompt.default}' is used`;
    return `Answer within ${formatTimeLeft(left)}; then ${then}.`;
  };

  const askInWindow = async (entry: PendingAsk) => {
    const { prompt } = entry;
    const hint = timeHint(entry);
    const title = hint ? `${entry.workflowName} asks. ${hint}` : `${entry.workflowName} asks`;
    const source = new vscode.CancellationTokenSource();
    entry.picker = source;
    let answer: string | undefined;
    try {
      if (prompt.choices) {
        const ordered =
          prompt.default !== undefined && prompt.choices.includes(prompt.default)
            ? [prompt.default, ...prompt.choices.filter((choice) => choice !== prompt.default)]
            : prompt.choices;
        const items = ordered.map((label) =>
          label === prompt.default ? { label, description: 'Default' } : { label },
        );
        const options = { title, placeHolder: prompt.question, ignoreFocusOut: true };
        answer = (await ui.pick(items, options, source.token))?.label;
      } else {
        answer = await ui.input(
          {
            title,
            prompt: prompt.question,
            ignoreFocusOut: true,
            ...(prompt.default !== undefined
              ? { value: prompt.default }
              : { validateInput: (value: string) => (value.trim() === '' ? 'Enter an answer.' : undefined) }),
          },
          source.token,
        );
      }
    } finally {
      if (entry.picker === source) entry.picker = undefined;
      source.dispose();
    }
    if (answer !== undefined && pending.get(prompt.requestId) === entry) entry.settle({ answer });
  };

  const showNotice = (entry: PendingAsk) => {
    entry.inline = false;
    if (entry.noticeOpen) return;
    entry.noticeOpen = true;
    const { requestId, question } = entry.prompt;
    ui.notify(`${entry.workflowName} asks: ${question}`, [ANSWER_BUTTON, OPEN_WORKFLOW_BUTTON]).then(
      (choice) => {
        entry.noticeOpen = false;
        if (choice === undefined) return;
        if (pending.get(requestId) !== entry) {
          ui.info(ALREADY_ANSWERED);
          return;
        }
        if (choice === ANSWER_BUTTON) {
          void askInWindow(entry).catch(() => undefined);
        } else if (choice === OPEN_WORKFLOW_BUTTON) {
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

  const withdraw = (entry: PendingAsk, reason?: unknown) => entry.settle({ error: abortError(reason) });

  return {
    onDidRequest: onDidRequest.event,
    onDidResolve: onDidResolve.event,
    onDidChangeWaiting: onDidChangeWaiting.event,

    request({ workflowUri, workflowName, ...rest }, signal) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      const prompt: AskPrompt = { ...rest, requestId: `ask-${randomUUID()}` };
      return new Promise<AskResult>((resolve, reject) => {
        const onAbort = () => withdraw(entry, signal?.reason);
        const entry: PendingAsk = {
          prompt,
          workflowUri,
          workflowName,
          inline: false,
          noticeOpen: false,
          settle(outcome) {
            if (pending.get(prompt.requestId) !== entry) return;
            pending.delete(prompt.requestId);
            signal?.removeEventListener('abort', onAbort);
            entry.picker?.cancel();
            if (entry.inline) onDidResolve.fire({ requestId: prompt.requestId, workflowUri });
            onDidChangeWaiting.fire(prompt.runId);
            if ('error' in outcome) reject(outcome.error);
            else resolve({ answer: outcome.answer });
          },
        };
        pending.set(prompt.requestId, entry);
        signal?.addEventListener('abort', onAbort, { once: true });
        onDidChangeWaiting.fire(prompt.runId);
        if (attachments.isAttached(workflowUri)) showInline(entry);
        else showNotice(entry);
      });
    },

    respond(requestId, answer) {
      const entry = pending.get(requestId);
      if (!entry) {
        ui.warn(`Ignored an answer to question ${requestId}: it is no longer open.`);
        return;
      }
      const { choices, stepId } = entry.prompt;
      if (typeof answer !== 'string' || (choices && !choices.includes(answer))) {
        ui.warn(`Ignored an answer to block '${stepId}': it isn't one of the choices.`);
        return;
      }
      entry.settle({ answer });
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
        if (entry.prompt.runId === runId) withdraw(entry);
      }
    },

    dispose() {
      for (const entry of [...pending.values()]) withdraw(entry);
      attachments.clear();
      onDidRequest.dispose();
      onDidResolve.dispose();
      onDidChangeWaiting.dispose();
    },
  };
}
