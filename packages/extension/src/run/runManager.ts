import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createRunView,
  parseWorkflowText,
  reduceRunEvent,
  runWorkflow,
  validateWorkflow,
  type RunEvent,
  type RunOptions,
  type RunView,
  type ShellName,
  type Workflow,
} from '@isar-flow/core';
import type { ActiveRun, RunManager, RunManagerDeps } from '../contracts';
import { createApprovalBroker, type RunApprovalBroker } from './approvals';
import { CommandApprovals, confirmCommands, consoleCommandsOf } from './commandApproval';
import { createEngineHost } from './engineHost';
import { errorMessage, formatDuration, formatElapsed } from './format';
import { createFileHistoryStore, createRunHistory, type FileRunHistory } from './history';
import { promptForInputs } from './inputs';
import { WorkflowSecrets } from './secrets';

export const WORKFLOW_EDITOR_VIEW_TYPE = 'isarFlow.workflowEditor';
const SHELLS: readonly ShellName[] = ['auto', 'pwsh', 'powershell', 'cmd', 'bash', 'sh'];
const TRUST_BUTTON = 'Manage Workspace Trust';
const UNTRUSTED_MESSAGE = "Workflows don't run in Restricted Mode. Trust this workspace to run them.";
const PROBLEMS_BUTTON = 'Show problems';
const OUTCOME_WORDS = { success: 'succeeded', failure: 'failed', cancelled: 'was cancelled' } as const;

/** The part of vscode.StatusBarItem the manager uses. */
export interface RunStatusItem {
  text: string;
  tooltip?: string | vscode.MarkdownString;
  command?: string | vscode.Command;
  name?: string;
  show(): void;
  dispose(): void;
}

/** Window and workspace access, injectable for tests. */
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
  /** Absolute path of the workspace folder the workflow belongs to. */
  workspaceRoot(uri: vscode.Uri): string;
  promptInputs(workflow: Workflow): Promise<Record<string, unknown> | undefined>;
  /** Modal used to confirm console commands; resolves to the chosen button. */
  confirmCommands(message: string, detail: string, buttons: string[]): Thenable<string | undefined>;
  createStatusItem(): RunStatusItem;
}

export interface RunManagerOptions {
  ui?: Partial<RunManagerUi>;
  history?: FileRunHistory;
  approvals?: RunApprovalBroker;
  secrets?: WorkflowSecrets;
  commandApprovals?: CommandApprovals;
  /** Process environment visible as `env.*`; defaults to process.env. */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface WorkflowRunManager extends RunManager {
  readonly history: FileRunHistory;
  readonly approvals: RunApprovalBroker;
  /** Resolves with the final view once the run has ended (from history for runs that already ended). */
  whenFinished(runId: string): Promise<RunView | undefined>;
}

interface LiveRun extends ActiveRun {
  name: string;
  controller: AbortController;
  statusItem: RunStatusItem;
  timer: ReturnType<typeof setInterval>;
}

const vscodeUi: RunManagerUi = {
  isTrusted: () => vscode.workspace.isTrusted,
  showInfo: (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons),
  showWarning: (message, ...buttons) => vscode.window.showWarningMessage(message, ...buttons),
  showError: (message, ...buttons) => vscode.window.showErrorMessage(message, ...buttons),
  executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  readText: (uri) => vscode.workspace.openTextDocument(uri).then((doc) => doc.getText()),
  setting: <T>(key: string, fallback: T, scope?: vscode.Uri) =>
    vscode.workspace.getConfiguration('isarFlow', scope).get<T>(key, fallback),
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

function fileName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Runs workflows with the core engine: validation, inputs, command confirmation, live events, status bar,
 * approvals and history. One live run per workflow.
 */
export function createRunManager(deps: RunManagerDeps, options: RunManagerOptions = {}): WorkflowRunManager {
  const ui: RunManagerUi = { ...vscodeUi, ...options.ui };
  const now = options.now ?? Date.now;
  const { context, log } = deps;
  const history =
    options.history ??
    createRunHistory(
      createFileHistoryStore(context.storageUri ?? context.globalStorageUri),
      context.workspaceState,
      () => ui.setting('historyLimit', 50),
    );
  const approvals = options.approvals ?? createApprovalBroker();
  const secrets = options.secrets ?? new WorkflowSecrets(context);
  const commandApprovals = options.commandApprovals ?? new CommandApprovals(context.workspaceState);

  const onEvent = new vscode.EventEmitter<{ workflowUri: string; event: RunEvent }>();
  const onDidChangeRuns = new vscode.EventEmitter<void>();
  const runs = new Map<string, LiveRun>();
  /** Completion of each run, kept until its history entry is saved. */
  const completions = new Map<string, Promise<RunView>>();
  /** Workflows between "start" and the first event (prompts may be open). */
  const starting = new Set<string>();
  const usedRunIds = new Set<string>();
  let disposed = false;

  const notify = (show: Thenable<string | undefined>, actions: Record<string, () => unknown>) => {
    show.then(
      (choice) => {
        if (choice !== undefined) void actions[choice]?.();
      },
      () => undefined,
    );
  };

  const newRunId = () => {
    const base = `run-${now().toString(36)}`;
    let runId = base;
    for (let n = 2; usedRunIds.has(runId); n++) runId = `${base}-${n}`;
    usedRunIds.add(runId);
    return runId;
  };

  /** Parses and validates; shows the refusal and returns undefined when the workflow has errors. */
  const validWorkflow = (text: string, uri: vscode.Uri): Workflow | undefined => {
    const parsed = parseWorkflowText(text);
    let errors = parsed.diagnostics.filter((d) => d.severity === 'error').length;
    if (parsed.workflow) {
      // Unknown models are only checked against a catalog that has finished loading.
      const catalog = deps.models.catalog();
      const checkModels = !catalog.loading && catalog.models.length > 0;
      const semantic = validateWorkflow(parsed.workflow, {
        agentIds: Object.keys(deps.agents.definitions()),
        ...(checkModels && { modelRefs: catalog.models.map((m) => m.ref) }),
      });
      errors += semantic.filter((d) => d.severity === 'error').length;
    }
    if (!parsed.valid && errors === 0) errors = 1;
    if (parsed.workflow && errors === 0) return parsed.workflow;
    notify(
      ui.showError(`Fix ${plural(errors, 'problem')} in ${fileName(uri)} before running.`, PROBLEMS_BUTTON),
      {
        [PROBLEMS_BUTTON]: () => ui.executeCommand('workbench.actions.view.problems'),
      },
    );
    return undefined;
  };

  const handleEvent = (run: LiveRun, event: RunEvent) => {
    run.view = reduceRunEvent(run.view, event);
    if (!disposed) onEvent.fire({ workflowUri: run.workflowUri, event });
    if (event.type === 'step-end' && event.status === 'failure') {
      log.warn(`Run ${run.runId}: block '${event.stepId}' failed: ${event.error ?? 'no details'}`);
    } else if (event.type === 'run-end') {
      const outcome = OUTCOME_WORDS[event.status];
      const summary = `Run ${run.runId} of '${run.name}' ${outcome} after ${formatDuration(event.durationMs)}`;
      if (event.status === 'failure') log.error(`${summary}: ${event.error ?? 'no details'}`);
      else log.info(`${summary}.`);
    }
  };

  const finish = async (run: LiveRun) => {
    clearInterval(run.timer);
    run.statusItem.dispose();
    runs.delete(run.runId);
    approvals.cancel(run.runId);
    try {
      await history.save(run.view, run.workflowUri);
    } catch (error) {
      log.error(`Could not save run ${run.runId} to the history: ${errorMessage(error)}`);
    }
    if (!disposed) onDidChangeRuns.fire();
  };

  const execute = async (run: LiveRun, workflow: Workflow, runOptions: RunOptions) => {
    const startedAt = now();
    try {
      for await (const event of runWorkflow(workflow, runOptions)) handleEvent(run, event);
    } catch (error) {
      log.error(`Run ${run.runId} stopped unexpectedly: ${errorMessage(error)}`);
    }
    if (run.view.status === 'running') {
      const aborted = run.controller.signal.aborted;
      handleEvent(run, {
        type: 'run-end',
        runId: run.runId,
        status: aborted ? 'cancelled' : 'failure',
        ...(!aborted && { error: 'The run stopped unexpectedly. See the Isar Flow log for details.' }),
        durationMs: now() - startedAt,
        usage: run.view.usage,
      });
    }
    await finish(run);
    return run.view;
  };

  const launch = async (uri: vscode.Uri, workflow: Workflow, inputs: Record<string, unknown>) => {
    const workflowUri = uri.toString();
    const runId = newRunId();
    const workspaceRoot = ui.workspaceRoot(uri);
    const tokenBudget = ui.setting('maxTokensPerRun', 0, uri);
    const configuredShell = ui.setting<string>('defaultShell', 'auto', uri);
    const defaultShell = SHELLS.find((s) => s === configuredShell) ?? 'auto';
    const secretValues = await secrets.getAll();
    const host = createEngineHost({
      runId,
      workspaceRoot,
      runCommand: deps.runCommand,
      terminal: deps.terminalFor(workflow.name),
      models: deps.models,
      toolHost: deps.tools(runId),
      readContextFiles: deps.readContextFiles,
      approve: (req, signal) =>
        approvals.request({ runId, stepId: req.stepId, message: req.message, workflowUri }, signal),
      now,
      secrets: secretValues,
    });

    const controller = new AbortController();
    const statusItem = ui.createStatusItem();
    const startedAt = now();
    const updateStatus = () => {
      statusItem.text = `$(sync~spin) ${workflow.name} ${formatElapsed(now() - startedAt)}`;
    };
    updateStatus();
    statusItem.tooltip = `${workflow.name} is running. Click to show the workflow.`;
    statusItem.command = {
      command: 'vscode.openWith',
      title: 'Show workflow',
      arguments: [uri, WORKFLOW_EDITOR_VIEW_TYPE],
    };
    statusItem.show();

    const run: LiveRun = {
      runId,
      workflowUri,
      name: workflow.name,
      view: createRunView(runId, workflow.name, startedAt, inputs),
      controller,
      statusItem,
      timer: setInterval(updateStatus, 1000),
    };
    runs.set(runId, run);
    log.info(`Run ${runId} of '${workflow.name}' started (${uri.fsPath}).`);
    onDidChangeRuns.fire();
    const completion = execute(run, workflow, {
      runId,
      inputs,
      host,
      agents: deps.agents.definitions(),
      signal: controller.signal,
      env: stringEnv(options.env ?? process.env),
      secrets: secretValues,
      workflowFile: uri.fsPath,
      workspaceRoot,
      ...(tokenBudget > 0 && { tokenBudget }),
      defaultShell,
      now,
    }).finally(() => completions.delete(runId));
    completions.set(runId, completion);
    return runId;
  };

  const liveRunOf = (workflowUri: string) => [...runs.values()].find((r) => r.workflowUri === workflowUri);

  return {
    onEvent: onEvent.event,
    onDidChangeRuns: onDidChangeRuns.event,
    history,
    approvals,

    async start(uri, inputs) {
      if (disposed) return undefined;
      if (!ui.isTrusted()) {
        notify(ui.showWarning(UNTRUSTED_MESSAGE, TRUST_BUTTON), {
          [TRUST_BUTTON]: () => ui.executeCommand('workbench.trust.manage'),
        });
        return undefined;
      }
      const workflowUri = uri.toString();
      if (liveRunOf(workflowUri)) {
        notify(ui.showInfo('This workflow is already running.'), {});
        return undefined;
      }
      if (starting.has(workflowUri)) return undefined;

      starting.add(workflowUri);
      try {
        let text: string;
        try {
          text = await ui.readText(uri);
        } catch (error) {
          notify(ui.showError(`Could not read ${fileName(uri)}: ${errorMessage(error)}`), {});
          return undefined;
        }
        const workflow = validWorkflow(text, uri);
        if (!workflow) return undefined;

        const values = inputs ?? (await ui.promptInputs(workflow));
        if (!values) return undefined;

        const confirmed = await confirmCommands({
          workflowUri,
          workflowName: workflow.name,
          commands: consoleCommandsOf(workflow),
          approvals: commandApprovals,
          enabled: ui.setting('confirmCommands', true, uri),
          ask: (message, detail, buttons) => Promise.resolve(ui.confirmCommands(message, detail, buttons)),
        });
        if (!confirmed || disposed) return undefined;
        return await launch(uri, workflow, values);
      } catch (error) {
        log.error(
          `Could not start ${fileName(uri)}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        notify(ui.showError(`Could not start ${fileName(uri)}: ${errorMessage(error)}`), {});
        return undefined;
      } finally {
        starting.delete(workflowUri);
      }
    },

    cancel(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.controller.abort();
      approvals.cancel(runId);
    },

    active(workflowUri) {
      return [...runs.values()]
        .filter((run) => workflowUri === undefined || run.workflowUri === workflowUri)
        .map(({ runId, workflowUri: uri, view }) => ({ runId, workflowUri: uri, view }));
    },

    async whenFinished(runId) {
      return completions.get(runId) ?? history.get(runId) ?? history.getAsync(runId);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const run of runs.values()) {
        run.controller.abort();
        clearInterval(run.timer);
        run.statusItem.dispose();
      }
      approvals.dispose();
      onEvent.dispose();
      onDidChangeRuns.dispose();
      history.dispose();
    },
  };
}
