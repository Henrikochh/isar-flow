import * as vscode from 'vscode';
import type { Services } from '../contracts';
import { fileKind, fileNameOf } from '../editors/files';
import { AGENT_EDITOR_VIEW_TYPE, WORKFLOW_EDITOR_VIEW_TYPE } from '../editors/host';

export const WORKFLOW_COMMAND_IDS = [
  'isarFlow.runWorkflow',
  'isarFlow.cancelRun',
  'isarFlow.openInCanvas',
  'isarFlow.openYaml',
  'isarFlow.showLog',
] as const;

const NEW_WORKFLOW = 'New workflow';

/** The parts of Services the commands use. */
export interface WorkflowCommandServices {
  workflows: Pick<Services['workflows'], 'list'>;
  runs: Pick<Services['runs'], 'start' | 'cancel' | 'active'>;
  output: Pick<Services['output'], 'show'>;
}

/** Window access, injectable for tests. */
export interface WorkflowCommandUi {
  /** File shown in the active editor tab (text or custom editor). */
  activeUri(): vscode.Uri | undefined;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: T[],
    options: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
  showInfo(message: string, ...actions: string[]): Thenable<string | undefined>;
  showError(message: string): Thenable<unknown>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
}

export interface WorkflowCommands {
  /** Returns the run id, or undefined when nothing was started. */
  runWorkflow(arg?: unknown): Promise<string | undefined>;
  cancelRun(arg?: unknown): Promise<void>;
  openInCanvas(arg?: unknown): Promise<void>;
  openYaml(arg?: unknown): Promise<void>;
  showLog(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// A scheme has at least two characters, so Windows paths like C:\x are not mistaken for URIs.
const hasScheme = (text: string) => /^[a-z][\w+.-]+:/i.test(text);

/** A file from a command argument: a Uri, a URI string or path, or an object with `uri` / `workflowUri`. */
export function uriArg(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (typeof arg === 'string') {
    if (!arg.trim()) return undefined;
    return hasScheme(arg) ? vscode.Uri.parse(arg) : vscode.Uri.file(arg);
  }
  if (isRecord(arg)) return uriArg(arg.uri) ?? uriArg(arg.workflowUri);
  return undefined;
}

function runIdArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  return isRecord(arg) && typeof arg.runId === 'string' ? arg.runId : undefined;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createWorkflowCommands(
  services: WorkflowCommandServices,
  ui: WorkflowCommandUi,
): WorkflowCommands {
  const { workflows, runs, output } = services;

  /** Asks for a workflow from the index; offers to create one when there is none. */
  const pickWorkflow = async (placeHolder: string): Promise<vscode.Uri | undefined> => {
    const list = workflows.list();
    if (list.length === 0) {
      const choice = await ui.showInfo(
        'No workflows found in this workspace. Create one to get started.',
        NEW_WORKFLOW,
      );
      if (choice === NEW_WORKFLOW) await ui.executeCommand('isarFlow.newWorkflow');
      return undefined;
    }
    const items = list.map((workflow) => ({
      label: workflow.name,
      description: workflow.relativePath,
      ...(!workflow.valid && { detail: '$(warning) Has problems. Fix them in the YAML before running.' }),
      uri: workflow.uri,
    }));
    const picked = await ui.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return picked && vscode.Uri.parse(picked.uri);
  };

  const open = async (uri: vscode.Uri, ...args: unknown[]) => {
    try {
      await ui.executeCommand('vscode.openWith', uri, ...args);
    } catch (error) {
      void ui.showError(`Could not open ${fileNameOf(uri)}: ${errorText(error)}`);
    }
  };

  return {
    async runWorkflow(arg) {
      const given = uriArg(arg);
      if (given && fileKind(given.path) !== 'workflow') {
        void ui.showError(
          `${fileNameOf(given)} is not a workflow. Workflow files end in .workflow.yaml or .workflow.yml.`,
        );
        return undefined;
      }
      const active = ui.activeUri();
      const uri =
        given ??
        (active && fileKind(active.path) === 'workflow'
          ? active
          : await pickWorkflow('Choose a workflow to run'));
      return uri && runs.start(uri);
    },

    async cancelRun(arg) {
      const live = runs.active();
      const runId = runIdArg(arg);
      if (runId !== undefined && live.some((run) => run.runId === runId)) {
        runs.cancel(runId);
        return;
      }
      // A plain string is a run id; only strings with a scheme name a workflow.
      const given = typeof arg === 'string' && !hasScheme(arg) ? undefined : uriArg(arg);
      if (given || runId !== undefined) {
        const matching = given ? runs.active(given.toString()) : [];
        if (matching.length === 0) {
          void ui.showInfo(given ? `${fileNameOf(given)} is not running.` : 'That run has already ended.');
        }
        for (const run of matching) runs.cancel(run.runId);
        return;
      }

      if (live.length === 0) {
        void ui.showInfo('No workflow is running.');
        return;
      }
      if (live.length === 1) {
        runs.cancel(live[0].runId);
        return;
      }
      const items = live.map((run) => ({
        label: run.view.workflowName,
        description: fileNameOf(vscode.Uri.parse(run.workflowUri)),
        detail: `Started at ${new Date(run.view.startedAt).toLocaleTimeString()}`,
        runId: run.runId,
      }));
      const picked = await ui.showQuickPick(items, { placeHolder: 'Choose a run to stop' });
      if (picked) runs.cancel(picked.runId);
    },

    async openInCanvas(arg) {
      const uri = uriArg(arg) ?? ui.activeUri() ?? (await pickWorkflow('Choose a workflow to open'));
      if (!uri) return;
      const kind = fileKind(uri.path);
      if (!kind) {
        void ui.showError(
          `${fileNameOf(uri)} is not a workflow or agent file. Isar Flow opens *.workflow.yaml and *.agent.yaml files.`,
        );
        return;
      }
      await open(uri, kind === 'workflow' ? WORKFLOW_EDITOR_VIEW_TYPE : AGENT_EDITOR_VIEW_TYPE);
    },

    async openYaml(arg) {
      const uri = uriArg(arg) ?? ui.activeUri();
      if (!uri) {
        void ui.showInfo('Open a workflow or agent in Isar Flow first, then open its YAML.');
        return;
      }
      await open(uri, 'default', vscode.ViewColumn.Beside);
    },

    showLog() {
      output.show();
    },
  };
}

const vscodeUi: WorkflowCommandUi = {
  activeUri() {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
    return vscode.window.activeTextEditor?.document.uri;
  },
  showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
  showInfo: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
  showError: (message) => vscode.window.showErrorMessage(message),
  executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
};

/** Registers run, stop, open-in-canvas, open-YAML and show-log commands. */
export function registerWorkflowCommands(
  services: Services,
  ui: WorkflowCommandUi = vscodeUi,
): vscode.Disposable {
  const commands = createWorkflowCommands(services, ui);
  const guarded =
    <A extends unknown[], R>(name: string, handler: (...args: A) => R | Promise<R>) =>
    async (...args: A): Promise<R | undefined> => {
      try {
        return await handler(...args);
      } catch (error) {
        services.output.error(
          `${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        void ui.showError(errorText(error));
        return undefined;
      }
    };
  return vscode.Disposable.from(
    vscode.commands.registerCommand('isarFlow.runWorkflow', guarded('Run workflow', commands.runWorkflow)),
    vscode.commands.registerCommand('isarFlow.cancelRun', guarded('Stop run', commands.cancelRun)),
    vscode.commands.registerCommand(
      'isarFlow.openInCanvas',
      guarded('Open in canvas', commands.openInCanvas),
    ),
    vscode.commands.registerCommand('isarFlow.openYaml', guarded('Open YAML', commands.openYaml)),
    vscode.commands.registerCommand('isarFlow.showLog', guarded('Show log', commands.showLog)),
  );
}
