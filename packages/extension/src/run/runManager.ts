import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createRunView,
  createSimulationHost,
  DEFAULT_CONTEXT_TOKENS,
  parseWorkflowText,
  reduceRunEvent,
  runOriginText,
  runWorkflow,
  validateWorkflow,
  workflowUsesRoot,
  type AgentDefinition,
  type EditorContext,
  type GitContext,
  type ResumeOptions,
  type RunEvent,
  type RunOptions,
  type RunOrigin,
  type RunView,
  type ShellName,
  type SimulationFile,
  type Workflow,
  type WorkflowIsolation,
} from '@isar-flow/core';
import type {
  ActiveRun,
  CommandConfirmationState,
  RunFinished,
  RunManager,
  RunManagerDeps,
  RunStartOptions,
  SimulationStore,
} from '../contracts';
import { contextTokensSetting } from '../models/settings';
import { worktreeNeedsGit } from '../safety/gitSnapshots';
import { createRunSafety, type RunSafety, type SafetySession } from '../safety/runSafety';
import { createSimulationStore } from '../simulation/simulationStore';
import { createApprovalBroker, type RunApprovalBroker } from './approvals';
import { createAskBroker, type RunAskBroker } from './asks';
import {
  CommandApprovals,
  confirmCommands,
  consoleCommandsOf,
  rememberStartedByHand,
  setupCommandsOf,
  triggerConfirmationState,
  unattendedAgentsOf,
} from './commandApproval';
import { createEngineHost, type EngineHostDeps } from './engineHost';
import { finishNotice } from './finishNotice';
import { errorMessage, formatDuration } from './format';
import { captureRunGit } from './gitCapture';
import { createFileHistoryStore, createRunHistory, type FileRunHistory } from './history';
import { runStatusText, vscodeRunManagerUi, type RunManagerUi, type RunStatusItem } from './managerUi';
import { WORKFLOW_EDITOR_VIEW_TYPE } from './notices';
import {
  CANCELLED_MESSAGE,
  missingInputMessage,
  neverPrompts,
  NOT_ALLOWED_MESSAGE,
  NOT_CONFIRMED_MESSAGE,
  STARTING_MESSAGE,
  StartRefusal,
  STOPPED_MESSAGE,
  triggerConfirmationMessage,
  triggerFirstRunMessage,
} from './refusals';
import { resumePlan } from './resumeSource';
import { WorkflowSecrets } from './secrets';
import { runSetupCommands } from './setupCommands';

export type { RunManagerUi, RunStatusItem } from './managerUi';
export { WORKFLOW_EDITOR_VIEW_TYPE } from './notices';
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
/** Opens the canvas on a run (registered by the workflow editor). */
const SHOW_RUN_COMMAND = 'isarFlow.internal.showRun';
const MANUAL: RunOrigin = { kind: 'manual' };

export interface RunManagerOptions {
  ui?: Partial<RunManagerUi>;
  history?: FileRunHistory;
  approvals?: RunApprovalBroker;
  /** Questions of ask blocks; created (and disposed with the manager) by default. */
  asks?: RunAskBroker;
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
  readonly asks: RunAskBroker;
  readonly simulations: SimulationStore;
  readonly onDidFinish: vscode.Event<RunFinished>;
  /** Resolves with the final view once the run has ended (from history for runs that already ended). */
  whenFinished(runId: string): Promise<RunView | undefined>;
  confirmationState(workflowUri: vscode.Uri): Promise<CommandConfirmationState>;
  /** Stops all runs like dispose() and resolves once the stopped runs are saved to the history. */
  shutdown(): Promise<void>;
}

interface LiveRun extends ActiveRun {
  name: string;
  /** Test mode: the run uses the simulation host and its mocks. */
  simulated: boolean;
  origin: RunOrigin;
  controller: AbortController;
  statusItem: RunStatusItem;
  timer: ReturnType<typeof setInterval>;
  /** Updates the status bar item (elapsed time, waiting for an answer). */
  refreshStatus(): void;
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
  origin: RunOrigin;
  /** `editor.*` captured when the run was started; only for workflows that read it. */
  editor?: EditorContext;
  /** Run from here: the saved run and block this run continues. */
  resume?: ResumeOptions;
}

const NOTICE_METHODS = { info: 'showInfo', warning: 'showWarning', error: 'showError' } as const;

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
const originPart = (origin: RunOrigin) => (origin.kind === 'manual' ? {} : { origin });

/** "started on save of src/app.ts" for the start log line; nothing for manual runs. */
function originWords(origin: RunOrigin): string[] {
  const sentence = runOriginText(origin)?.sentence;
  return sentence ? [`${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`] : [];
}

/**
 * Runs workflows with the core engine: validation, inputs, command confirmation, live events, status bar,
 * approvals, questions and history. One live run per workflow. Also continues saved runs at a block (Run from
 * here), simulates runs with the mocks of the workflow's simulation file (test mode) and tells about finished runs
 * when no editor of the workflow is visible.
 */
export function createRunManager(deps: RunManagerDeps, options: RunManagerOptions = {}): WorkflowRunManager {
  const ui: RunManagerUi = { ...vscodeRunManagerUi, ...options.ui };
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
  const asks = options.asks ?? createAskBroker({ warn: (message) => log.warn(message) });
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
  const onDidFinish = new vscode.EventEmitter<RunFinished>();
  const runs = new Map<string, LiveRun>();
  /** Completion of each run, kept until its history entry is saved. */
  const completions = new Map<string, Promise<RunView>>();
  /** Workflows between "start" and the first event (prompts may be open). */
  const starting = new Set<string>();
  const usedRunIds = new Set<string>();
  let disposed = false;

  const refreshWaiting = (runId: string) => runs.get(runId)?.refreshStatus();
  const subscriptions = [
    approvals.onDidChangeWaiting(refreshWaiting),
    asks.onDidChangeWaiting(refreshWaiting),
  ];

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

  /** Parses and validates without telling anyone: the workflow, or how many problems it has. */
  const checkWorkflow = (text: string): { workflow: Workflow } | { errors: number } => {
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
    return parsed.workflow && errors === 0 ? { workflow: parsed.workflow } : { errors };
  };

  /** Reads the current text (unsaved edits included) and validates it. */
  const readWorkflow = async (uri: vscode.Uri): Promise<Workflow | StartRefusal> => {
    let text: string;
    try {
      text = await ui.readText(uri);
    } catch (error) {
      return new StartRefusal('invalid', `Could not read ${fileName(uri)}: ${errorMessage(error)}`, {
        kind: 'error',
      });
    }
    const checked = checkWorkflow(text);
    if ('workflow' in checked) return checked.workflow;
    return new StartRefusal(
      'invalid',
      `Fix ${plural(checked.errors, 'problem')} in ${fileName(uri)} before running.`,
      {
        kind: 'error',
        buttons: { [PROBLEMS_BUTTON]: () => ui.executeCommand('workbench.actions.view.problems') },
      },
    );
  };

  /** What the command confirmation covers for this workflow (see confirmCommands). */
  const confirmationOf = (uri: vscode.Uri, workflow: Workflow, agents: Record<string, AgentDefinition>) => ({
    workflowUri: uri.toString(),
    workflowName: workflow.name,
    commands: consoleCommandsOf(workflow),
    agents: unattendedAgentsOf(workflow, agents),
    approvals: commandApprovals,
    enabled: ui.setting('confirmCommands', true, uri),
  });

  /** Tells the caller (onRefused) or the person (a notification) why a start stopped. */
  const report = (uri: vscode.Uri, refusal: StartRefusal, startOptions: RunStartOptions) => {
    if (startOptions.onRefused) {
      log.info(`${fileName(uri)} did not start: ${refusal.message}`);
      try {
        startOptions.onRefused({ reason: refusal.reason, message: refusal.message });
      } catch (error) {
        log.error(`Could not report why ${fileName(uri)} did not start: ${errorMessage(error)}`);
      }
      return;
    }
    if (!refusal.notice || disposed) return;
    const { kind, buttons = {} } = refusal.notice;
    notify(ui[NOTICE_METHODS[kind]](refusal.message, ...Object.keys(buttons)), buttons);
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
    asks.cancel(run.runId);
    try {
      await history.save(run.view, run.workflowUri);
    } catch (error) {
      log.error(`Could not save run ${run.runId} to the history: ${errorMessage(error)}`);
    }
    if (!disposed) onDidChangeRuns.fire();
  };

  /**
   * After the run is saved and its review published: fires onDidFinish and tells about the outcome (an editor of
   * the workflow that is visible shows it itself, so then only changed files are reported).
   */
  const announce = async (run: LiveRun, workspaceRoot: string, changed: number) => {
    let changedFiles: string[] = [];
    if (changed > 0 && !run.simulated && !disposed) {
      try {
        const review = await safety.reviews.get(run.runId);
        changedFiles = review?.files.map((file) => path.join(workspaceRoot, file.path)) ?? [];
      } catch (error) {
        log.warn(`Could not list the files run ${run.runId} changed: ${errorMessage(error)}`);
      }
    }
    if (disposed) return;
    const { view } = run;
    onDidFinish.fire({
      runId: run.runId,
      workflowUri: run.workflowUri,
      workflowName: run.name,
      status: view.status === 'running' ? 'failure' : view.status,
      view,
      changedFiles,
      origin: run.origin,
      simulated: run.simulated,
    });
    const notice = finishNotice({
      name: run.name,
      view,
      origin: run.origin,
      simulated: run.simulated,
      changed,
      editorVisible: asks.isAttached(run.workflowUri) || approvals.isAttached(run.workflowUri),
    });
    if (!notice) return;
    const openRun = () => ui.executeCommand(SHOW_RUN_COMMAND, run.workflowUri, run.runId);
    const method = notice.kind === 'error' ? 'showError' : 'showInfo';
    notify(
      ui[method](notice.message, ...notice.buttons),
      Object.fromEntries(notice.buttons.map((button) => [button, openRun])),
    );
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
      ...originPart(plan.origin),
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
    await announce(run, plan.workspaceRoot, 0);
    return run.view;
  };

  /** `git.*` for workflows that read it, from the real workspace folder; never in Restricted Mode. */
  const gitFor = async (
    workflow: Workflow,
    root: string,
    signal: AbortSignal,
  ): Promise<GitContext | undefined> => {
    if (!deps.codeContext || !ui.isTrusted() || !workflowUsesRoot(workflow, 'git')) return undefined;
    return captureRunGit(deps.codeContext, root, signal, (message) => log.warn(message));
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
    const git = await gitFor(plan.workflow, plan.workspaceRoot, run.controller.signal);
    if (run.controller.signal.aborted) return stopBeforeEngine(run, plan, startedAt, undefined);
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
    const memory = deps.memory?.forRun(root, {
      ...(session && { journal: session.journal }),
      secrets: Object.values(plan.secrets),
    });
    // Nobody waits for a triggered run: its ask blocks take their default (else the first choice) in the engine.
    const ask: EngineHostDeps['ask'] =
      plan.origin.kind === 'trigger'
        ? undefined
        : (prompt, signal) =>
            asks.request({ ...prompt, runId, workflowUri: run.workflowUri, workflowName: run.name }, signal);
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
          {
            runId,
            stepId: req.stepId,
            message: req.message,
            workflowUri: run.workflowUri,
            workflowName: run.name,
          },
          signal,
        ),
      ...(ask && { ask }),
      now,
      secrets: plan.secrets,
      contextTokens: plan.contextTokens,
      ...(memory && { memory }),
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
        ...(plan.editor && { editor: plan.editor }),
        ...(git && { git }),
        ...originPart(plan.origin),
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
    await announce(run, plan.workspaceRoot, changed);
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
    origin: RunOrigin,
  ) => {
    const runId = newRunId();
    const statusItem = ui.createStatusItem();
    const startedAt = now();
    const { name } = workflow;
    const updateStatus = () => {
      const waiting = asks.waiting(runId) ? 'answer' : approvals.waiting(runId) ? 'approval' : undefined;
      const status = runStatusText({
        name,
        simulated,
        elapsedMs: now() - startedAt,
        ...(waiting && { waiting }),
      });
      statusItem.text = status.text;
      statusItem.tooltip = status.tooltip;
    };
    updateStatus();
    statusItem.command = {
      command: 'vscode.openWith',
      title: 'Show workflow',
      arguments: [uri, WORKFLOW_EDITOR_VIEW_TYPE],
    };
    statusItem.show();

    const run: LiveRun = {
      runId,
      workflowUri: uri.toString(),
      name,
      simulated,
      origin,
      view: createRunView(runId, name, startedAt, inputs),
      controller: new AbortController(),
      statusItem,
      timer: setInterval(updateStatus, 1000),
      refreshStatus: updateStatus,
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
    origin: RunOrigin,
    editor: EditorContext | undefined,
  ): Promise<string | StartRefusal> => {
    const workspaceRoot = ui.workspaceRoot(uri);
    const isolation = workflow.isolation === 'worktree' ? 'worktree' : 'workspace';
    if (isolation === 'worktree' && !(await safety.canIsolate(workspaceRoot))) {
      return new StartRefusal('error', worktreeNeedsGit(workspaceRoot), { kind: 'error' });
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
      origin,
      ...(editor && { editor }),
      ...(resume && { resume }),
    };

    const run = register(uri, workflow, inputs, false, origin);
    const where = [
      uri.fsPath,
      ...(isolation === 'worktree' ? ['in a git worktree'] : []),
      ...(resume ? [`from block '${resume.stepId}' of run ${resume.fromRunId}`] : []),
      ...originWords(origin),
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
    origin: RunOrigin,
    editor: EditorContext | undefined,
  ) => {
    const runSecrets = ui.isTrusted() ? await secrets.getAll() : {};
    const workspaceRoot = ui.workspaceRoot(uri);
    const run = register(uri, workflow, inputs, true, origin);
    const where = [uri.fsPath, ...originWords(origin)];
    log.info(`Simulated run ${run.runId} of '${workflow.name}' started (${where.join(', ')}).`);
    return track(run, async () => {
      const git = await gitFor(workflow, workspaceRoot, run.controller.signal);
      const runOptions: RunOptions = {
        runId: run.runId,
        inputs,
        host: createSimulationHost({ file, delayMs: options.simulationDelayMs ?? SIMULATION_DELAY_MS }),
        agents: deps.agents.definitions(),
        signal: run.controller.signal,
        env: stringEnv(options.env ?? process.env),
        secrets: runSecrets,
        workflowFile: uri.fsPath,
        workspaceRoot,
        defaultShell: shellOf(uri),
        now,
        simulated: true,
        ...(editor && { editor }),
        ...(git && { git }),
        ...originPart(origin),
      };
      await drive(run, workflow, runOptions, run.view.startedAt);
      await finish(run);
      await announce(run, workspaceRoot, 0);
      return run.view;
    });
  };

  const liveRunOf = (workflowUri: string) => [...runs.values()].find((r) => r.workflowUri === workflowUri);

  /** One start per workflow at a time: refuses while it runs or while another start is still asking. */
  const startOnce = async (
    uri: vscode.Uri,
    task: () => Promise<string | StartRefusal>,
  ): Promise<string | StartRefusal> => {
    const workflowUri = uri.toString();
    if (liveRunOf(workflowUri)) return new StartRefusal('running', RUNNING_MESSAGE, { kind: 'info' });
    if (starting.has(workflowUri)) return new StartRefusal('running', STARTING_MESSAGE);
    starting.add(workflowUri);
    try {
      return await task();
    } catch (error) {
      log.error(
        `Could not start ${fileName(uri)}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      return new StartRefusal('error', `Could not start ${fileName(uri)}: ${errorMessage(error)}`, {
        kind: 'error',
      });
    } finally {
      starting.delete(workflowUri);
    }
  };

  /** The editor captured at start, for workflows that read `editor.*`. */
  const editorFor = (workflow: Workflow, captured: EditorContext | undefined) =>
    captured && workflowUsesRoot(workflow, 'editor') ? captured : undefined;

  /** Input values without prompts (triggers, Copilot) or from the input boxes; a refusal when that fails. */
  const inputsFor = async (
    workflow: Workflow,
    given: Record<string, unknown> | undefined,
    origin: RunOrigin,
  ): Promise<Record<string, unknown> | StartRefusal> => {
    if (neverPrompts(origin)) {
      const values = given ?? {};
      const missing = missingInputMessage(workflow, values, origin);
      return missing === undefined ? values : new StartRefusal('inputs', missing, { kind: 'error' });
    }
    const values = given ?? (await ui.promptInputs(workflow));
    return values ?? new StartRefusal('cancelled', CANCELLED_MESSAGE);
  };

  const startRun = (
    uri: vscode.Uri,
    inputs: Record<string, unknown> | undefined,
    startOptions: RunStartOptions,
    origin: RunOrigin,
    editor: EditorContext | undefined,
  ) =>
    startOnce(uri, async () => {
      const workflow = await readWorkflow(uri);
      if (workflow instanceof StartRefusal) return workflow;

      let given = inputs;
      let resume: ResumeOptions | undefined;
      if (startOptions.resume) {
        const plan = await resumePlan(history, uri.toString(), workflow, startOptions.resume);
        if ('error' in plan) return new StartRefusal('invalid', plan.error, { kind: 'error' });
        resume = plan.resume;
        given ??= plan.inputs;
      }
      const values = await inputsFor(workflow, given, origin);
      if (values instanceof StartRefusal) return values;

      // One snapshot for the question and the run: an agent file changed while the question is open
      // must not run with permissions nobody confirmed.
      const agents = deps.agents.definitions();
      const confirmation = confirmationOf(uri, workflow, agents);
      if (origin.kind === 'trigger') {
        const state = triggerConfirmationState(confirmation);
        if (state !== 'approved') {
          const message = (state === 'needed' ? triggerConfirmationMessage : triggerFirstRunMessage)(
            workflow.name,
          );
          return new StartRefusal('confirmation', message, { kind: 'warning' });
        }
      } else {
        const confirmed = await confirmCommands({
          ...confirmation,
          ask: (message, detail, buttons) => Promise.resolve(ui.confirmCommands(message, detail, buttons)),
        });
        if (!confirmed) return new StartRefusal('confirmation', NOT_CONFIRMED_MESSAGE);
        await rememberStartedByHand(confirmation);
      }
      if (disposed) return new StartRefusal('error', STOPPED_MESSAGE);
      return launch(uri, workflow, values, agents, resume, origin, editorFor(workflow, editor));
    });

  const startSimulation = (
    uri: vscode.Uri,
    inputs: Record<string, unknown> | undefined,
    origin: RunOrigin,
    editor: EditorContext | undefined,
  ) =>
    startOnce(uri, async () => {
      const workflow = await readWorkflow(uri);
      if (workflow instanceof StartRefusal) return workflow;
      let file: SimulationFile;
      try {
        file = await simulations.load(uri);
      } catch (error) {
        return new StartRefusal('invalid', errorMessage(error), {
          kind: 'error',
          buttons: {
            [OPEN_SIMULATION_BUTTON]: () =>
              simulations.open(uri).catch((cause: unknown) => {
                notify(ui.showError(`Could not open the simulation file: ${errorMessage(cause)}`), {});
              }),
          },
        });
      }
      const values = await inputsFor(workflow, inputs, origin);
      if (values instanceof StartRefusal) return values;
      if (disposed) return new StartRefusal('error', STOPPED_MESSAGE);
      return await simulate(uri, workflow, values, file, origin, editorFor(workflow, editor));
    });

  /** `editor.*` as it is when the start begins, before any prompt can move the focus. */
  const captureEditor = (uri: vscode.Uri, startOptions: RunStartOptions): EditorContext | undefined => {
    if (startOptions.editor) return startOptions.editor;
    if (!deps.codeContext) return undefined;
    // Nobody started a triggered run at the editor: a schedule or a file change must not read whatever happens
    // to be selected (an .env file, say) and hand it to a model. A save trigger only sees the saved file.
    const origin = startOptions.origin;
    if (origin?.kind === 'trigger' && origin.trigger !== 'save') return undefined;
    try {
      const editor = deps.codeContext.editor(ui.workspaceRoot(uri));
      if (origin?.kind === 'trigger' && editor?.file !== origin.file) return undefined;
      return editor;
    } catch (error) {
      log.warn(`Could not read the active editor: ${errorMessage(error)}`);
      return undefined;
    }
  };

  const attemptStart = async (
    uri: vscode.Uri,
    inputs: Record<string, unknown> | undefined,
    startOptions: RunStartOptions,
    editor: EditorContext | undefined,
  ): Promise<string | StartRefusal> => {
    if (disposed) return new StartRefusal('error', STOPPED_MESSAGE);
    const origin = startOptions.origin ?? MANUAL;
    if (neverPrompts(origin) && (startOptions.simulate || startOptions.resume)) {
      return new StartRefusal('not-allowed', NOT_ALLOWED_MESSAGE, { kind: 'error' });
    }
    if (startOptions.resume && startOptions.simulate) {
      return new StartRefusal('not-allowed', SIMULATED_RESUME_MESSAGE, { kind: 'error' });
    }
    // Simulations run nothing, so they work in Restricted Mode too.
    if (startOptions.simulate) return startSimulation(uri, inputs, origin, editor);
    if (!ui.isTrusted()) {
      return new StartRefusal('untrusted', UNTRUSTED_MESSAGE, {
        kind: 'warning',
        buttons: { [TRUST_BUTTON]: () => ui.executeCommand('workbench.trust.manage') },
      });
    }
    return startRun(uri, inputs, startOptions, origin, editor);
  };

  return {
    onEvent: onEvent.event,
    onDidChangeRuns: onDidChangeRuns.event,
    onDidFinish: onDidFinish.event,
    history,
    approvals,
    asks,
    reviews: safety.reviews,
    simulations,

    async start(uri, inputs, startOptions = {}) {
      const editor = captureEditor(uri, startOptions);
      const outcome = await attemptStart(uri, inputs, startOptions, editor);
      if (typeof outcome === 'string') return outcome;
      report(uri, outcome, startOptions);
      return undefined;
    },

    async confirmationState(uri) {
      let text: string;
      try {
        text = await ui.readText(uri);
      } catch {
        return 'invalid';
      }
      const checked = checkWorkflow(text);
      if (!('workflow' in checked)) return 'invalid';
      return triggerConfirmationState(confirmationOf(uri, checked.workflow, deps.agents.definitions()));
    },

    cancel(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.controller.abort();
      approvals.cancel(runId);
      asks.cancel(runId);
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
      for (const subscription of subscriptions) subscription.dispose();
      approvals.dispose();
      asks.dispose();
      safety.dispose();
      simulations.dispose();
      onEvent.dispose();
      onDidChangeRuns.dispose();
      onDidFinish.dispose();
      history.dispose();
    },
  };
}
