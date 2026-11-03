import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createRunView,
  createSimulationHost,
  DEFAULT_CONTEXT_TOKENS,
  parseWorkflowText,
  reduceRunEvent,
  runWorkflow,
  validateWorkflow,
  type AgentDefinition,
  type ResumeOptions,
  type RunEvent,
  type RunOptions,
  type RunView,
  type ShellName,
  type SimulationFile,
  type Workflow,
  type WorkflowIsolation,
} from '@isar-flow/core';
import type { ActiveRun, RunManager, RunManagerDeps, RunStartOptions, SimulationStore } from '../contracts';
import { contextTokensSetting } from '../models/settings';
import { worktreeNeedsGit } from '../safety/gitSnapshots';
import { createRunSafety, type RunSafety, type SafetySession } from '../safety/runSafety';
import { createSimulationStore } from '../simulation/simulationStore';
import { createApprovalBroker, type RunApprovalBroker } from './approvals';
import {
  CommandApprovals,
  confirmCommands,
  consoleCommandsOf,
  setupCommandsOf,
  unattendedAgentsOf,
} from './commandApproval';
import { createEngineHost } from './engineHost';
import { errorMessage, formatDuration, formatElapsed } from './format';
import { createFileHistoryStore, createRunHistory, type FileRunHistory } from './history';
import { promptForInputs } from './inputs';
import { resumePlan } from './resumeSource';
import { WorkflowSecrets } from './secrets';
import { runSetupCommands } from './setupCommands';

export const WORKFLOW_EDITOR_VIEW_TYPE = 'isarFlow.workflowEditor';
/** Pause per simulated host call, so the canvas shows a simulated run block by block. */
export const SIMULATION_DELAY_MS = 250;
const SHELLS: readonly ShellName[] = ['auto', 'pwsh', 'powershell', 'cmd', 'bash', 'sh'];
const TRUST_BUTTON = 'Manage Workspace Trust';
const UNTRUSTED_MESSAGE = "Workflows don't run in Restricted Mode. Trust this workspace to run them.";
const RUNNING_MESSAGE = 'This workflow is already running.';
const SIMULATED_RESUME_MESSAGE = "Run from here can't be simulated. Simulate the whole workflow instead.";
const PROBLEMS_BUTTON = 'Show problems';
const OPEN_SIMULATION_BUTTON = 'Open simulation file';
const OUTCOME_WORDS = { success: 'succeeded', failure: 'failed', cancelled: 'was cancelled' } as const;
const REVIEW_BUTTON = 'Review changes';
/** Opens the canvas on a run (registered by the workflow editor). */
const SHOW_RUN_COMMAND = 'isarFlow.internal.showRun';

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
  /** Absolute path of the workspace folder that contains the workflow; undefined outside all folders. */
  workspaceFolder(uri: vscode.Uri): string | undefined;
  /** Folder console commands run in: the workflow's folder, else the first folder, else the file's folder. */
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
  /**
   * Context file reader for one workspace folder, so multi-root workspaces read `context.files` from the
   * workflow's own folder. Defaults to deps.readContextFiles.
   */
  readContextFilesIn?: (workspaceRoot: string) => RunManagerDeps['readContextFiles'];
  /** Snapshots, edit journal and review; created in the extension storage by default. */
  safety?: RunSafety;
  /** Simulation files of the workflows; created (and disposed with the manager) by default. */
  simulations?: SimulationStore;
  /** Pause per host call of simulated runs in ms (default SIMULATION_DELAY_MS); tests set 0 or a long one. */
  simulationDelayMs?: number;
  now?: () => number;
}

export interface WorkflowRunManager extends RunManager {
  readonly history: FileRunHistory;
  readonly approvals: RunApprovalBroker;
  readonly simulations: SimulationStore;
  /** Resolves with the final view once the run has ended (from history for runs that already ended). */
  whenFinished(runId: string): Promise<RunView | undefined>;
  /** Stops all runs like dispose() and resolves once the stopped runs are saved to the history. */
  shutdown(): Promise<void>;
}

interface LiveRun extends ActiveRun {
  name: string;
  /** Test mode: the run uses the simulation host and its mocks. */
  simulated: boolean;
  controller: AbortController;
  statusItem: RunStatusItem;
  timer: ReturnType<typeof setInterval>;
}

/** Everything a run needs once it is registered: the workflow, inputs and the settings read at start. */
interface RunPlan {
  workflow: Workflow;
  inputs: Record<string, unknown>;
  agents: Record<string, AgentDefinition>;
  uri: vscode.Uri;
  /** Folder console commands run in (see RunManagerUi.workspaceRoot); the snapshot covers it. */
  workspaceRoot: string;
  /** Workspace folder of the workflow; undefined outside all folders (agent tools use the first folder). */
  folder: string | undefined;
  isolation: WorkflowIsolation;
  defaultShell: ShellName;
  tokenBudget: number;
  contextTokens: number;
  secrets: Record<string, string>;
  /** Run from here: the saved run and block this run continues. */
  resume?: ResumeOptions;
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

function fileName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const runLabel = (run: LiveRun) => (run.simulated ? 'Simulated run' : 'Run');

/**
 * Runs workflows with the core engine: validation, inputs, command confirmation, live events, status bar,
 * approvals and history. One live run per workflow. Also continues saved runs at a block (Run from here) and
 * simulates runs with the mocks of the workflow's simulation file (test mode).
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
  const simulations = options.simulations ?? createSimulationStore();
  const safety =
    options.safety ??
    createRunSafety({
      storageDir:
        (context.storageUri ?? context.globalStorageUri)?.fsPath ?? path.join(os.tmpdir(), 'isar-flow'),
      log,
      history,
    });
  // Restricted Mode runs no git commands in the workspace; the next trusted start cleans up.
  if (ui.isTrusted()) {
    safety
      .cleanup()
      .catch((error: unknown) => log.warn(`Could not clean up old run snapshots: ${errorMessage(error)}`));
  }

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

  /** Reads the current text (unsaved edits included) and validates it; shows why when that fails. */
  const readWorkflow = async (uri: vscode.Uri): Promise<Workflow | undefined> => {
    let text: string;
    try {
      text = await ui.readText(uri);
    } catch (error) {
      notify(ui.showError(`Could not read ${fileName(uri)}: ${errorMessage(error)}`), {});
      return undefined;
    }
    return validWorkflow(text, uri);
  };

  const handleEvent = (run: LiveRun, event: RunEvent) => {
    run.view = reduceRunEvent(run.view, event);
    if (!disposed) onEvent.fire({ workflowUri: run.workflowUri, event });
    if (event.type === 'step-end' && event.status === 'failure' && !event.reused) {
      log.warn(
        `${runLabel(run)} ${run.runId}: block '${event.stepId}' failed: ${event.error ?? 'no details'}`,
      );
    } else if (event.type === 'run-end') {
      const outcome = OUTCOME_WORDS[event.status];
      const summary = `${runLabel(run)} ${run.runId} of '${run.name}' ${outcome} after ${formatDuration(event.durationMs)}`;
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

  /** Feeds the engine's events into the run and ends it like the engine would when the engine stopped early. */
  const drive = async (run: LiveRun, workflow: Workflow, runOptions: RunOptions, startedAt: number) => {
    try {
      for await (const event of runWorkflow(workflow, runOptions)) handleEvent(run, event);
    } catch (error) {
      log.error(`${runLabel(run)} ${run.runId} stopped unexpectedly: ${errorMessage(error)}`);
    }
    if (run.view.status !== 'running') return;
    const aborted = run.controller.signal.aborted;
    handleEvent(run, {
      type: 'run-end',
      runId: run.runId,
      status: aborted ? 'cancelled' : 'failure',
      ...(!aborted && { error: 'The run stopped unexpectedly. See the Isar Flow log for details.' }),
      durationMs: now() - startedAt,
      usage: run.view.usage,
    });
  };

  /**
   * Ends a run that never reached the engine (no worktree, a failed or cancelled setup) with a start and an end
   * event, like the engine would, and drops its snapshots and worktree.
   */
  const stopBeforeEngine = async (
    run: LiveRun,
    plan: RunPlan,
    startedAt: number,
    error: string | undefined,
    session?: SafetySession,
  ) => {
    handleEvent(run, {
      type: 'run-start',
      runId: run.runId,
      workflowName: run.name,
      startedAt,
      inputs: plan.inputs,
      ...(plan.resume && { resumedFrom: { runId: plan.resume.fromRunId, stepId: plan.resume.stepId } }),
    });
    handleEvent(run, {
      type: 'run-end',
      runId: run.runId,
      status: error === undefined ? 'cancelled' : 'failure',
      ...(error !== undefined && { error }),
      durationMs: now() - startedAt,
      usage: run.view.usage,
    });
    await session
      ?.discard()
      .catch((cause: unknown) => log.warn(`Could not clean up run ${run.runId}: ${errorMessage(cause)}`));
    await finish(run);
    return run.view;
  };

  /** Snapshot (and worktree) before the run. A workspace run goes ahead without them when that fails. */
  const beginSafety = async (
    run: LiveRun,
    plan: RunPlan,
  ): Promise<{ session?: SafetySession; error?: string }> => {
    try {
      const folder = plan.workspaceRoot;
      return {
        session: await safety.begin({
          runId: run.runId,
          workflowUri: run.workflowUri,
          folder,
          isolation: plan.isolation,
        }),
      };
    } catch (error) {
      if (plan.isolation === 'worktree') return { error: errorMessage(error) };
      log.warn(`Run ${run.runId} runs without snapshots: ${errorMessage(error)}`);
      return {};
    }
  };

  const execute = async (run: LiveRun, plan: RunPlan) => {
    const startedAt = now();
    const { runId } = run;
    const isolated = plan.isolation === 'worktree';
    const { session, error } = await beginSafety(run, plan);
    if (error !== undefined) return stopBeforeEngine(run, plan, startedAt, error);

    const terminal = deps.terminalFor(plan.workflow.name);
    const root = session?.root ?? plan.workspaceRoot;
    const setup = isolated ? setupCommandsOf(plan.workflow) : [];
    if (setup.length > 0) {
      const stopped = await runSetupCommands({
        commands: setup,
        cwd: root,
        shell: plan.defaultShell,
        runCommand: deps.runCommand,
        terminal,
        signal: run.controller.signal,
        now,
      });
      if (stopped)
        return stopBeforeEngine(
          run,
          plan,
          startedAt,
          'error' in stopped ? stopped.error : undefined,
          session,
        );
    }

    // Agents only see workspace folders: a workflow outside all folders gets the default (first) folder.
    const toolRoot = isolated ? root : plan.folder;
    const contextRoot = isolated ? root : plan.folder;
    const host = createEngineHost({
      runId,
      workspaceRoot: root,
      runCommand: deps.runCommand,
      terminal,
      models: deps.models,
      toolHost: deps.tools(runId, toolRoot, session ? { journal: session.journal } : {}),
      readContextFiles: (contextRoot && options.readContextFilesIn?.(contextRoot)) || deps.readContextFiles,
      approve: (req, signal) =>
        approvals.request(
          { runId, stepId: req.stepId, message: req.message, workflowUri: run.workflowUri },
          signal,
        ),
      now,
      secrets: plan.secrets,
      contextTokens: plan.contextTokens,
    });
    await drive(
      run,
      plan.workflow,
      {
        runId,
        inputs: plan.inputs,
        host,
        agents: plan.agents,
        signal: run.controller.signal,
        env: stringEnv(options.env ?? process.env),
        secrets: plan.secrets,
        workflowFile: plan.uri.fsPath,
        workspaceRoot: root,
        ...(plan.tokenBudget > 0 && { tokenBudget: plan.tokenBudget }),
        defaultShell: plan.defaultShell,
        now,
        ...(plan.resume && { resume: plan.resume }),
      },
      startedAt,
    );

    // The run stays active until its after snapshot is taken, so the same workflow can't start in between.
    let changed = 0;
    if (session) {
      try {
        changed = await session.finish({ skipSnapshot: disposed });
      } catch (error) {
        log.error(`Could not build the review of run ${runId}: ${errorMessage(error)}`);
      }
    }
    await finish(run);
    await session?.publish().catch((error: unknown) => {
      log.warn(`Could not publish the review of run ${runId}: ${errorMessage(error)}`);
    });
    if (changed > 0 && !disposed) {
      notify(ui.showInfo(`${run.name} changed ${plural(changed, 'file')}.`, REVIEW_BUTTON), {
        [REVIEW_BUTTON]: () => ui.executeCommand(SHOW_RUN_COMMAND, run.workflowUri, runId),
      });
    }
    return run.view;
  };

  const shellOf = (uri: vscode.Uri): ShellName => {
    const configured = ui.setting<string>('defaultShell', 'auto', uri);
    return SHELLS.find((s) => s === configured) ?? 'auto';
  };

  /** Registers a live run with its status bar item; the caller starts it with `track`. */
  const register = (
    uri: vscode.Uri,
    workflow: Workflow,
    inputs: Record<string, unknown>,
    simulated: boolean,
  ) => {
    const runId = newRunId();
    const statusItem = ui.createStatusItem();
    const startedAt = now();
    const updateStatus = () => {
      const elapsed = formatElapsed(now() - startedAt);
      statusItem.text = simulated
        ? `$(beaker) ${workflow.name} (simulated) ${elapsed}`
        : `$(sync~spin) ${workflow.name} ${elapsed}`;
    };
    updateStatus();
    statusItem.tooltip = simulated
      ? `Simulating ${workflow.name}. Click to show the workflow.`
      : `${workflow.name} is running. Click to show the workflow.`;
    statusItem.command = {
      command: 'vscode.openWith',
      title: 'Show workflow',
      arguments: [uri, WORKFLOW_EDITOR_VIEW_TYPE],
    };
    statusItem.show();

    const run: LiveRun = {
      runId,
      workflowUri: uri.toString(),
      name: workflow.name,
      simulated,
      view: createRunView(runId, workflow.name, startedAt, inputs),
      controller: new AbortController(),
      statusItem,
      timer: setInterval(updateStatus, 1000),
    };
    runs.set(runId, run);
    return run;
  };

  const track = (run: LiveRun, start: () => Promise<RunView>) => {
    onDidChangeRuns.fire();
    const tracked = start().finally(() => completions.delete(run.runId));
    completions.set(run.runId, tracked);
    return run.runId;
  };

  const launch = async (
    uri: vscode.Uri,
    workflow: Workflow,
    inputs: Record<string, unknown>,
    agents: Record<string, AgentDefinition>,
    resume: ResumeOptions | undefined,
  ) => {
    const workspaceRoot = ui.workspaceRoot(uri);
    const isolation = workflow.isolation === 'worktree' ? 'worktree' : 'workspace';
    if (isolation === 'worktree' && !(await safety.canIsolate(workspaceRoot))) {
      notify(ui.showError(worktreeNeedsGit(workspaceRoot)), {});
      return undefined;
    }
    const plan: RunPlan = {
      workflow,
      inputs,
      agents,
      uri,
      workspaceRoot,
      folder: ui.workspaceFolder(uri),
      isolation,
      defaultShell: shellOf(uri),
      tokenBudget: ui.setting('maxTokensPerRun', 0, uri),
      contextTokens:
        contextTokensSetting(ui.setting<unknown>('agentContextTokens', undefined, uri)) ??
        DEFAULT_CONTEXT_TOKENS,
      secrets: await secrets.getAll(),
      ...(resume && { resume }),
    };

    const run = register(uri, workflow, inputs, false);
    const where = [
      uri.fsPath,
      ...(isolation === 'worktree' ? ['in a git worktree'] : []),
      ...(resume ? [`from block '${resume.stepId}' of run ${resume.fromRunId}`] : []),
    ];
    log.info(`Run ${run.runId} of '${workflow.name}' started (${where.join(', ')}).`);
    return track(run, () => execute(run, plan));
  };

  /** Test mode: the simulation host answers every host call from the mocks; nothing runs or changes files. */
  const simulate = async (
    uri: vscode.Uri,
    workflow: Workflow,
    inputs: Record<string, unknown>,
    file: SimulationFile,
  ) => {
    const runSecrets = ui.isTrusted() ? await secrets.getAll() : {};
    const run = register(uri, workflow, inputs, true);
    log.info(`Simulated run ${run.runId} of '${workflow.name}' started (${uri.fsPath}).`);
    const runOptions: RunOptions = {
      runId: run.runId,
      inputs,
      host: createSimulationHost({ file, delayMs: options.simulationDelayMs ?? SIMULATION_DELAY_MS }),
      agents: deps.agents.definitions(),
      signal: run.controller.signal,
      env: stringEnv(options.env ?? process.env),
      secrets: runSecrets,
      workflowFile: uri.fsPath,
      workspaceRoot: ui.workspaceRoot(uri),
      defaultShell: shellOf(uri),
      now,
      simulated: true,
    };
    return track(run, async () => {
      await drive(run, workflow, runOptions, run.view.startedAt);
      await finish(run);
      return run.view;
    });
  };

  const liveRunOf = (workflowUri: string) => [...runs.values()].find((r) => r.workflowUri === workflowUri);

  /** One start per workflow at a time: refuses while it runs or while another start is still asking. */
  const startOnce = async (
    uri: vscode.Uri,
    task: () => Promise<string | undefined>,
  ): Promise<string | undefined> => {
    const workflowUri = uri.toString();
    if (liveRunOf(workflowUri)) {
      notify(ui.showInfo(RUNNING_MESSAGE), {});
      return undefined;
    }
    if (starting.has(workflowUri)) return undefined;
    starting.add(workflowUri);
    try {
      return await task();
    } catch (error) {
      log.error(
        `Could not start ${fileName(uri)}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      notify(ui.showError(`Could not start ${fileName(uri)}: ${errorMessage(error)}`), {});
      return undefined;
    } finally {
      starting.delete(workflowUri);
    }
  };

  const startRun = (
    uri: vscode.Uri,
    inputs: Record<string, unknown> | undefined,
    startOptions: RunStartOptions,
  ) =>
    startOnce(uri, async () => {
      const workflow = await readWorkflow(uri);
      if (!workflow) return undefined;

      let values = inputs;
      let resume: ResumeOptions | undefined;
      if (startOptions.resume) {
        const plan = await resumePlan(history, uri.toString(), workflow, startOptions.resume);
        if ('error' in plan) {
          notify(ui.showError(plan.error), {});
          return undefined;
        }
        resume = plan.resume;
        values ??= plan.inputs;
      }
      values ??= await ui.promptInputs(workflow);
      if (!values) return undefined;

      // One snapshot for the question and the run: an agent file changed while the question is open
      // must not run with permissions nobody confirmed.
      const agents = deps.agents.definitions();
      const confirmed = await confirmCommands({
        workflowUri: uri.toString(),
        workflowName: workflow.name,
        commands: consoleCommandsOf(workflow),
        agents: unattendedAgentsOf(workflow, agents),
        approvals: commandApprovals,
        enabled: ui.setting('confirmCommands', true, uri),
        ask: (message, detail, buttons) => Promise.resolve(ui.confirmCommands(message, detail, buttons)),
      });
      if (!confirmed || disposed) return undefined;
      return await launch(uri, workflow, values, agents, resume);
    });

  const startSimulation = (uri: vscode.Uri, inputs: Record<string, unknown> | undefined) =>
    startOnce(uri, async () => {
      const workflow = await readWorkflow(uri);
      if (!workflow) return undefined;
      let file: SimulationFile;
      try {
        file = await simulations.load(uri);
      } catch (error) {
        notify(ui.showError(errorMessage(error), OPEN_SIMULATION_BUTTON), {
          [OPEN_SIMULATION_BUTTON]: () =>
            simulations.open(uri).catch((cause: unknown) => {
              notify(ui.showError(`Could not open the simulation file: ${errorMessage(cause)}`), {});
            }),
        });
        return undefined;
      }
      const values = inputs ?? (await ui.promptInputs(workflow));
      if (!values || disposed) return undefined;
      return await simulate(uri, workflow, values, file);
    });

  return {
    onEvent: onEvent.event,
    onDidChangeRuns: onDidChangeRuns.event,
    history,
    approvals,
    reviews: safety.reviews,
    simulations,

    async start(uri, inputs, startOptions = {}) {
      if (disposed) return undefined;
      if (startOptions.resume && startOptions.simulate) {
        notify(ui.showError(SIMULATED_RESUME_MESSAGE), {});
        return undefined;
      }
      // Simulations run nothing, so they work in Restricted Mode too.
      if (startOptions.simulate) return startSimulation(uri, inputs);
      if (!ui.isTrusted()) {
        notify(ui.showWarning(UNTRUSTED_MESSAGE, TRUST_BUTTON), {
          [TRUST_BUTTON]: () => ui.executeCommand('workbench.trust.manage'),
        });
        return undefined;
      }
      return startRun(uri, inputs, startOptions);
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

    async shutdown() {
      const pending = [...completions.values()];
      this.dispose();
      await Promise.allSettled(pending);
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
      safety.dispose();
      simulations.dispose();
      onEvent.dispose();
      onDidChangeRuns.dispose();
      history.dispose();
    },
  };
}
