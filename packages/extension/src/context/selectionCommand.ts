import * as vscode from 'vscode';
import type { WorkflowSummary } from '@isar-flow/core';
import type { RunManager, Services, WorkflowStore } from '../contracts';
import { fileKind } from '../editors/files';
import { editorContextFor, type EditorLike, snapshotEditor } from './editorContext';
import { createEditorTracker } from './editorTracker';

export const SELECTION_COMMAND_ID = 'isarFlow.runWorkflowOnSelection';

const NEW_WORKFLOW = 'New workflow';
const NO_EDITOR = 'Open a file and select some text, then run a workflow on it.';

export interface SelectionCommandServices {
  workflows: Pick<WorkflowStore, 'list'>;
  runs: Pick<RunManager, 'start'>;
}

/** Window access, injectable for tests. */
export interface SelectionCommandUi {
  /** The text editor to run on: the active one, else the most recently active visible one. */
  currentEditor(): EditorLike | undefined;
  /** Document of the active text editor, also when it is not one a run captures (e.g. a workflow file). */
  activeDocument(): vscode.Uri | undefined;
  /** Absolute path of the workspace folder that contains `uri`. */
  workspaceFolderOf(uri: vscode.Uri): string | undefined;
  firstFolder(): string | undefined;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
  showInfo(message: string, ...actions: string[]): Thenable<string | undefined>;
  showError(message: string): Thenable<unknown>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
}

type WorkflowItem = vscode.QuickPickItem & { uri?: string };

const separator = (label: string): WorkflowItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

function workflowItem(workflow: WorkflowSummary): WorkflowItem {
  const detail = workflow.valid ? workflow.description : '$(warning) Has problems';
  return {
    label: workflow.name,
    description: workflow.relativePath,
    ...(detail && { detail }),
    uri: workflow.uri,
  };
}

/** Workflows that read `editor.*` first, under their own header. */
function workflowItems(list: WorkflowSummary[]): WorkflowItem[] {
  const usesEditor = list.filter((workflow) => workflow.usesEditor);
  const others = list.filter((workflow) => !workflow.usesEditor);
  if (usesEditor.length === 0) return others.map(workflowItem);
  return [
    separator('Use the selection'),
    ...usesEditor.map(workflowItem),
    ...(others.length > 0 ? [separator('Other workflows'), ...others.map(workflowItem)] : []),
  ];
}

// A scheme has at least two characters, so Windows paths like C:\x are not mistaken for URIs.
const hasScheme = (text: string) => /^[a-z][\w+.-]+:/i.test(text);

function uriOf(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (typeof arg !== 'string' || !arg.trim()) return undefined;
  return hasScheme(arg) ? vscode.Uri.parse(arg) : vscode.Uri.file(arg);
}

/** A workflow URI passed by a caller; the editor context menu passes the edited file, which is ignored. */
function workflowArg(arg: unknown, activeDocument: vscode.Uri | undefined): vscode.Uri | undefined {
  const uri = uriOf(arg);
  if (!uri || fileKind(uri.path) !== 'workflow') return undefined;
  return uri.toString() === activeDocument?.toString() ? undefined : uri;
}

/**
 * "Run workflow on selection": captures the editor first (it can change while the QuickPick is open), lets the
 * user pick a workflow (or takes the one passed), then starts it with origin `selection`. The canvas stays closed.
 */
export function createSelectionCommand(
  services: SelectionCommandServices,
  ui: SelectionCommandUi,
): (arg?: unknown) => Promise<string | undefined> {
  return async (arg) => {
    const editor = ui.currentEditor();
    if (!editor) {
      void ui.showInfo(NO_EDITOR);
      return undefined;
    }
    const snapshot = snapshotEditor(editor);

    let uri = workflowArg(arg, ui.activeDocument());
    if (!uri) {
      const list = services.workflows.list();
      if (list.length === 0) {
        if ((await ui.showInfo('No workflows yet.', NEW_WORKFLOW)) === NEW_WORKFLOW) {
          await ui.executeCommand('isarFlow.newWorkflow');
        }
        return undefined;
      }
      const placeHolder = snapshot.selection
        ? 'Run a workflow on the selection'
        : 'Run a workflow (nothing selected: editor.selection is empty)';
      const picked = await ui.showQuickPick(workflowItems(list), { placeHolder, matchOnDescription: true });
      if (!picked?.uri) return undefined;
      uri = vscode.Uri.parse(picked.uri);
    }

    const root = ui.workspaceFolderOf(uri) ?? ui.firstFolder() ?? '';
    return services.runs.start(uri, undefined, {
      origin: { kind: 'selection' },
      editor: editorContextFor(snapshot, root),
    });
  };
}

function vscodeUi(tracker: { current(): EditorLike | undefined }): SelectionCommandUi {
  return {
    currentEditor: () => tracker.current(),
    activeDocument: () => vscode.window.activeTextEditor?.document.uri,
    workspaceFolderOf: (uri) => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath,
    firstFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
    showInfo: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    showError: (message) => vscode.window.showErrorMessage(message),
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Registers `isarFlow.runWorkflowOnSelection` (optional argument: a workflow URI, which skips the QuickPick). */
export function registerSelectionCommand(services: Services): vscode.Disposable {
  const tracker = createEditorTracker();
  const ui = vscodeUi(tracker);
  const run = createSelectionCommand(services, ui);
  const command = vscode.commands.registerCommand(SELECTION_COMMAND_ID, async (arg?: unknown) => {
    try {
      return await run(arg);
    } catch (error) {
      services.output.error(
        `Run workflow on selection failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      void ui.showError(`Could not run the workflow on the selection: ${errorText(error)}`);
      return undefined;
    }
  });
  return vscode.Disposable.from(command, tracker);
}
