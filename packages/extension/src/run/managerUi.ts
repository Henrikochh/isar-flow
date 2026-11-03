import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Workflow } from '@isar-flow/core';
import { formatElapsed } from './format';
import { promptForInputs } from './inputs';

/** The part of vscode.StatusBarItem the manager uses. */
export interface RunStatusItem {
  text: string;
  tooltip?: string | vscode.MarkdownString;
  command?: string | vscode.Command;
  name?: string;
  show(): void;
  dispose(): void;
}

/** Window and workspace access of the run manager, injectable for tests. */
export interface RunManagerUi {
  isTrusted(): boolean;
  showInfo(message: string, ...buttons: string[]): Thenable<string | undefined>;
  showWarning(message: string, ...buttons: string[]): Thenable<string | undefined>;
  showError(message: string, ...buttons: string[]): Thenable<string | undefined>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  /** Current text of the document, unsaved edits included. */
  readText(uri: vscode.Uri): Thenable<string>;
  /** An `isarFlow.*` setting (key without the prefix). */
  setting<T>(key: string, fallback: T, scope?: vscode.Uri): T;
  /** Absolute path of the workspace folder that contains the workflow; undefined outside all folders. */
  workspaceFolder(uri: vscode.Uri): string | undefined;
  /** Folder console commands run in: the workflow's folder, else the first folder, else the file's folder. */
  workspaceRoot(uri: vscode.Uri): string;
  promptInputs(workflow: Workflow): Promise<Record<string, unknown> | undefined>;
  /** Modal used to confirm console commands; resolves to the chosen button. */
  confirmCommands(message: string, detail: string, buttons: string[]): Thenable<string | undefined>;
  createStatusItem(): RunStatusItem;
}

export const vscodeRunManagerUi: RunManagerUi = {
  isTrusted: () => vscode.workspace.isTrusted,
  showInfo: (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons),
  showWarning: (message, ...buttons) => vscode.window.showWarningMessage(message, ...buttons),
  showError: (message, ...buttons) => vscode.window.showErrorMessage(message, ...buttons),
  executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  readText: (uri) => vscode.workspace.openTextDocument(uri).then((doc) => doc.getText()),
  setting: <T>(key: string, fallback: T, scope?: vscode.Uri) =>
    vscode.workspace.getConfiguration('isarFlow', scope).get<T>(key, fallback),
  workspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath,
  workspaceRoot: (uri) =>
    vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    path.dirname(uri.fsPath),
  promptInputs: (workflow) => promptForInputs(workflow),
  confirmCommands: (message, detail, buttons) =>
    vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons),
  createStatusItem: () => {
    const item = vscode.window.createStatusBarItem('isarFlow.run', vscode.StatusBarAlignment.Left, 10);
    item.name = 'Isar Flow run';
    return item;
  },
};

export interface RunStatusState {
  name: string;
  simulated: boolean;
  elapsedMs: number;
  /** An open question or approval of the run. */
  waiting?: 'answer' | 'approval';
}

/** Text and tooltip of a run's status bar item (clicking it shows the workflow). */
export function runStatusText({ name, simulated, elapsedMs, waiting }: RunStatusState): {
  text: string;
  tooltip: string;
} {
  if (waiting === 'answer') {
    return {
      text: `$(comment-discussion) ${name}: Waiting for your answer`,
      tooltip: `${name} is waiting for your answer. Click to show the workflow.`,
    };
  }
  if (waiting === 'approval') {
    return {
      text: `$(bell) ${name}: Waiting for approval`,
      tooltip: `${name} is waiting for your approval. Click to show the workflow.`,
    };
  }
  const elapsed = formatElapsed(elapsedMs);
  return simulated
    ? {
        text: `$(beaker) ${name} (simulated) ${elapsed}`,
        tooltip: `Simulating ${name}. Click to show the workflow.`,
      }
    : { text: `$(sync~spin) ${name} ${elapsed}`, tooltip: `${name} is running. Click to show the workflow.` };
}
