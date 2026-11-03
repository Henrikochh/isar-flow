import * as vscode from 'vscode';
import { parseWorkflowText, resumePreview } from '@isar-flow/core';
import type { RunHistory, Services, SimulationStore } from '../contracts';
import { fileKind, fileNameOf } from '../editors/files';
import { AGENT_EDITOR_VIEW_TYPE, WORKFLOW_EDITOR_VIEW_TYPE } from '../editors/host';
import { blockAt } from '../liveValues/hover';
import { blockLabel, resumeWarnings } from '../run/resumeWarnings';

export const WORKFLOW_COMMAND_IDS = [
  'isarFlow.runWorkflow',
  'isarFlow.simulateWorkflow',
  'isarFlow.runFromHere',
  'isarFlow.openSimulationFile',
  'isarFlow.cancelRun',
  'isarFlow.openInCanvas',
  'isarFlow.openYaml',
  'isarFlow.showLog',
] as const;

const NEW_WORKFLOW = 'New workflow';
const RUN_FROM_HERE = 'Run from here';

/** The parts of Services the commands use. */
export interface WorkflowCommandServices {
  workflows: Pick<Services['workflows'], 'list'>;
  runs: Pick<Services['runs'], 'start' | 'cancel' | 'active'> & {
    history: Pick<RunHistory, 'list' | 'getAsync'>;
    simulations?: Pick<SimulationStore, 'open'>;
  };
  output: Pick<Services['output'], 'show'>;
}

/** Window access, injectable for tests. */
export interface WorkflowCommandUi {
  /** File shown in the active editor tab (text or custom editor). */
  activeUri(): vscode.Uri | undefined;
  /** Text and cursor of the active text editor when it shows `uri`. */
  cursor(uri: vscode.Uri): { text: string; line: number; character: number } | undefined;
  readText(uri: vscode.Uri): Thenable<string>;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: T[],
    options: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
  showInfo(message: string, ...actions: string[]): Thenable<string | undefined>;
  showError(message: string): Thenable<unknown>;
  /** Modal warning; resolves to `button` when it was chosen. */
  confirm(message: string, detail: string, button: string): Thenable<string | undefined>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
}

export interface WorkflowCommands {
  /** Returns the run id, or undefined when nothing was started. */
  runWorkflow(arg?: unknown): Promise<string | undefined>;
  /** Test mode: runs the workflow with its mocks. Returns the run id, or undefined when nothing was started. */
  simulateWorkflow(arg?: unknown): Promise<string | undefined>;
  /**
   * Continues a run at a block: `{ uri, runId?, stepId? }`, else the newest real run of the active workflow at
   * the block under the cursor (or a picked one). Returns the run id, or undefined when nothing was started.
   */
  runFromHere(arg?: unknown): Promise<string | undefined>;
  openSimulationFile(arg?: unknown): Promise<void>;
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

const stepIdArg = (arg: unknown) =>
  isRecord(arg) && typeof arg.stepId === 'string' ? arg.stepId : undefined;

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

  /** The workflow passed as argument, else the one in the active editor, else one the user picks. */
  const workflowArg = async (arg: unknown, placeHolder: string): Promise<vscode.Uri | undefined> => {
    const given = uriArg(arg);
    if (given && fileKind(given.path) !== 'workflow') {
      void ui.showError(
        `${fileNameOf(given)} is not a workflow. Workflow files end in .workflow.yaml or .workflow.yml.`,
      );
      return undefined;
    }
    const active = ui.activeUri();
    return (
      given ?? (active && fileKind(active.path) === 'workflow' ? active : await pickWorkflow(placeHolder))
    );
  };

  /** The block under the YAML cursor, else one the user picks (`stoppedAt` is marked). */
  const pickBlock = async (uri: vscode.Uri, stoppedAt: string | undefined): Promise<string | undefined> => {
    const cursor = ui.cursor(uri);
    const { stepRanges } = parseWorkflowText(cursor?.text ?? (await ui.readText(uri)));
    const atCursor = cursor && blockAt(stepRanges, cursor);
    if (atCursor) return atCursor;
    const items = Object.keys(stepRanges).map((id) => ({
      label: id,
      ...(id === stoppedAt && { description: 'Where that run stopped' }),
    }));
    const picked = await ui.showQuickPick(items, { placeHolder: 'Choose the block to run from' });
    return picked?.label;
  };

  /**
   * Shows what to check before a run continues (changed or missing results, …), like the canvas dialog does, and
   * resolves to false when the user cancels. Runs and blocks the run manager refuses pass, so it says why.
   */
  const confirmResume = async (uri: vscode.Uri, runId: string, stepId: string): Promise<boolean> => {
    const saved = runs.history.list(uri.toString()).some((record) => record.runId === runId);
    const source = saved ? await runs.history.getAsync(runId) : undefined;
    if (!source) return true;
    const { workflow } = parseWorkflowText(ui.cursor(uri)?.text ?? (await ui.readText(uri)));
    if (!workflow) return true;
    const preview = resumePreview(workflow, source, stepId);
    const warnings = preview.blocker === undefined ? resumeWarnings(preview, workflow) : [];
    if (warnings.length === 0) return true;
    const message = `Run ${workflow.name} from ${blockLabel(workflow, stepId)}?`;
    return (await ui.confirm(message, warnings.join('\n'), RUN_FROM_HERE)) === RUN_FROM_HERE;
  };

  return {
    async runWorkflow(arg) {
      const uri = await workflowArg(arg, 'Choose a workflow to run');
      return uri && runs.start(uri);
    },

    async simulateWorkflow(arg) {
      const uri = await workflowArg(arg, 'Choose a workflow to simulate');
      return uri && runs.start(uri, undefined, { simulate: true });
    },

    async runFromHere(arg) {
      const uri = await workflowArg(arg, 'Choose a workflow to continue');
      if (!uri) return undefined;
      // Simulated runs can't be continued, so the newest real run is the one to continue.
      const source = runs.history.list(uri.toString()).find((record) => !record.simulated);
      const runId = (isRecord(arg) && runIdArg(arg)) || source?.runId;
      if (!runId) {
        void ui.showInfo(`${fileNameOf(uri)} has no run to continue. Run it first, then run from a block.`);
        return undefined;
      }
      const stepId = stepIdArg(arg) ?? (await pickBlock(uri, source?.stoppedAt));
      if (!stepId || !(await confirmResume(uri, runId, stepId))) return undefined;
      // Inputs default to that run's; the run manager says why a run can't continue.
      return runs.start(uri, undefined, { resume: { runId, stepId } });
    },

    async openSimulationFile(arg) {
      const uri = await workflowArg(arg, 'Choose a workflow to edit its simulation mocks');
      if (!uri || !runs.simulations) return;
      try {
        await runs.simulations.open(uri);
      } catch (error) {
        void ui.showError(`Could not open the simulation file: ${errorText(error)}`);
      }
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
  cursor(uri) {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.toString() !== uri.toString()) return undefined;
    const { line, character } = editor.selection.active;
    return { text: editor.document.getText(), line, character };
  },
  readText: (uri) => vscode.workspace.openTextDocument(uri).then((document) => document.getText()),
  showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
  showInfo: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
  showError: (message) => vscode.window.showErrorMessage(message),
  confirm: (message, detail, button) =>
    vscode.window.showWarningMessage(message, { modal: true, detail }, button),
  executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
};

/** Registers run, simulate, run-from-here, stop, open (canvas, YAML, simulation file) and show-log commands. */
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
    vscode.commands.registerCommand(
      'isarFlow.simulateWorkflow',
      guarded('Simulate workflow', commands.simulateWorkflow),
    ),
    vscode.commands.registerCommand('isarFlow.runFromHere', guarded('Run from here', commands.runFromHere)),
    vscode.commands.registerCommand(
      'isarFlow.openSimulationFile',
      guarded('Open simulation file', commands.openSimulationFile),
    ),
    vscode.commands.registerCommand('isarFlow.cancelRun', guarded('Stop run', commands.cancelRun)),
    vscode.commands.registerCommand(
      'isarFlow.openInCanvas',
      guarded('Open in canvas', commands.openInCanvas),
    ),
    vscode.commands.registerCommand('isarFlow.openYaml', guarded('Open YAML', commands.openYaml)),
    vscode.commands.registerCommand('isarFlow.showLog', guarded('Show log', commands.showLog)),
  );
}
