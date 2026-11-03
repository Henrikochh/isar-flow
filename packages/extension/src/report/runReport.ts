import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  type RunReportAction,
  type RunReportGenerator,
  runReportFileName,
  runReportMarkdown,
  type RunView,
} from '@isar-flow/core';
import { readText as readFileText } from '../store/files';
import { formatLocalTime } from './formatTime';
import { gatherReportInput, type ReportSources } from './reportInput';

const SAVED = 'Saved the run report.';
const OPEN = 'Open';
const COPIED = 'Copied the run summary for a pull request.';
const COPIED_MS = 4000;
const RUNNING = 'Wait until the run has finished.';
const NOT_FOUND = 'That run is no longer in the history.';

/** Window and file functions of the report actions; injected so they can be unit-tested. */
export interface ReportUi {
  /** Text of a file, an open editor's (unsaved) text first. */
  readText(uri: vscode.Uri): Promise<string>;
  showSaveDialog(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  writeFile(uri: vscode.Uri, text: string): Promise<void>;
  showInfo(message: string, ...actions: string[]): Thenable<string | undefined>;
  showError(message: string): void;
  openFile(uri: vscode.Uri): Thenable<unknown>;
  writeClipboard(text: string): Thenable<void>;
  setStatusBarMessage(text: string, hideAfterMs: number): void;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: T[],
    options: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
  /** The workspace folder of a file, else the first folder; undefined without folders. */
  folderOf(uri: vscode.Uri | undefined): vscode.Uri | undefined;
}

/** The Markdown generator (core's runReportMarkdown and runReportFileName); replaced in tests. */
export interface ReportGenerator {
  markdown: RunReportGenerator;
  fileName(run: RunView): string;
}

export interface RunReportRequest {
  /** Workflow of the run when the history has no record of it. */
  workflowUri?: string;
  /** Export: write here without asking (commands and tests). */
  target?: vscode.Uri;
  ui?: ReportUi;
  generator?: ReportGenerator;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const vscodeReportUi: ReportUi = {
  readText: async (uri) => {
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    return open ? open.getText() : readFileText(uri);
  },
  showSaveDialog: (options) => vscode.window.showSaveDialog(options),
  writeFile: async (uri, text) => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text)),
  showInfo: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
  showError: (message) => void vscode.window.showErrorMessage(message),
  openFile: (uri) => vscode.commands.executeCommand('vscode.open', uri),
  writeClipboard: (text) => vscode.env.clipboard.writeText(text),
  setStatusBarMessage: (text, hideAfterMs) => void vscode.window.setStatusBarMessage(text, hideAfterMs),
  showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
  folderOf: (uri) =>
    (uri && vscode.workspace.getWorkspaceFolder(uri)?.uri) ?? vscode.workspace.workspaceFolders?.[0]?.uri,
};

const coreGenerator = (): ReportGenerator => ({ markdown: runReportMarkdown, fileName: runReportFileName });

/**
 * Export report (a Markdown file) or Copy for PR description (the clipboard) for a finished run. Resolves with
 * the Markdown it saved or copied; undefined when nothing happened (running run, cancelled dialog, failure —
 * the user was told why).
 */
export async function runReport(
  sources: ReportSources,
  runId: string,
  action: RunReportAction,
  request: RunReportRequest = {},
): Promise<string | undefined> {
  const ui = request.ui ?? vscodeReportUi;
  const generator = request.generator ?? coreGenerator();
  if (sources.runs.active().some((run) => run.runId === runId)) {
    void ui.showInfo(RUNNING);
    return undefined;
  }
  const gathered = await gatherReportInput(sources, runId, {
    readText: (uri) => ui.readText(uri),
    ...(request.workflowUri !== undefined && { workflowUri: request.workflowUri }),
  });
  if (!gathered) {
    ui.showError(NOT_FOUND);
    return undefined;
  }
  const variant = action === 'export' ? 'full' : 'pr';
  const text = generator.markdown(gathered.input, { variant, formatTime: formatLocalTime });
  if (action === 'copyForPr') {
    try {
      await ui.writeClipboard(text);
    } catch (error) {
      ui.showError(`Could not copy the run summary: ${errorText(error)}`);
      return undefined;
    }
    ui.setStatusBarMessage(COPIED, COPIED_MS);
    return text;
  }

  const workflowUri = gathered.workflowUri === undefined ? undefined : vscode.Uri.parse(gathered.workflowUri);
  const target = request.target ?? (await askTarget(ui, generator.fileName(gathered.input.run), workflowUri));
  if (!target) return undefined;
  try {
    await ui.writeFile(target, text);
  } catch (error) {
    ui.showError(`Could not save the run report: ${errorText(error)}`);
    return undefined;
  }
  void Promise.resolve(ui.showInfo(SAVED, OPEN)).then((choice) => {
    if (choice === OPEN) void ui.openFile(target);
  });
  return text;
}

function askTarget(ui: ReportUi, fileName: string, workflowUri: vscode.Uri | undefined) {
  const folder = ui.folderOf(workflowUri);
  return ui.showSaveDialog({
    defaultUri: folder
      ? vscode.Uri.joinPath(folder, fileName)
      : vscode.Uri.file(path.join(os.homedir(), fileName)),
    filters: { Markdown: ['md'] },
    saveLabel: 'Save report',
    title: 'Export run report',
  });
}
