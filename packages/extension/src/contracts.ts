/**
 * Interfaces between the extension-host modules. Each module implements its part against these
 * contracts; src/extension.ts composes them.
 */
import type * as vscode from 'vscode';
import type {
  AgentDefinition,
  AgentScope,
  AgentSummary,
  ApprovalPrompt,
  ApprovalResult,
  AskPrompt,
  AskResult,
  ChatModel,
  EditorContext,
  GitContext,
  MemoryFileState,
  ModelCatalog,
  ModelProbeResult,
  ModelResolver,
  ProjectMemory,
  ReviewCounts,
  ReviewFileStatus,
  RunEvent,
  RunOrigin,
  RunRecordSummary,
  RunReview,
  RunStatus,
  RunView,
  SetupReport,
  SimulationFile,
  SimulationResult,
  SimulationState,
  Workflow,
  WorkflowSummary,
  WorkflowTemplateId,
  WorkflowTriggerState,
} from '@isar-flow/core';
import type { EditJournalWriter, RunConsoleCommand, ToolHostFactory } from '@isar-flow/core/node';

/*
 * Console runner and agent tool types live in the Node-only part of core (`@isar-flow/core/node`), shared with the
 * command line runner. They are re-exported here so extension modules keep importing them from '../contracts'.
 */
export type {
  ConsoleRunOptions,
  EditJournalWriter,
  PermissionAnswer,
  PermissionPrompt,
  PermissionRequest,
  ResolvedShell,
  RunConsoleCommand,
  ToolHostFactory,
  ToolHostOptions,
  ToolHostRunOptions,
  WorkspaceAdapter,
} from '@isar-flow/core/node';

/* ---------- console runner (src/runner) ---------- */

/** A terminal tab that mirrors run output live ("Isar Flow: <workflow>"). */
export interface RunTerminal {
  write(text: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

/* ---------- models (src/models) ---------- */

/** Entry of the `isarFlow.providers` setting. API keys live in SecretStorage, never in settings. */
export interface ProviderConfig {
  id: string;
  label?: string;
  baseUrl: string;
  discoverModels?: boolean;
  models?: string[];
  headers?: Record<string, string>;
}

export interface ModelRegistry extends ModelResolver {
  readonly onDidChange: vscode.Event<void>;
  /** Current snapshot (may still be loading). */
  catalog(): ModelCatalog;
  /** Re-reads settings, re-discovers models. */
  refresh(): Promise<ModelCatalog>;
  /**
   * Resolves a model. When the cached probe of `ref` says 'text', the model reports `capabilities.tools: false`,
   * so agents with toolMode auto use text tool calls.
   */
  resolve(ref: string): Promise<ChatModel>;
  /**
   * "Test model": one tool call, one JSON answer, latency. Caches the result (catalog().probes) and fires
   * onDidChange when it starts and ends. Never rejects; failures come back as outcome 'failed'.
   */
  probe?(ref: string, signal?: AbortSignal): Promise<ModelProbeResult>;
  dispose(): void;
}

/** "Check setup": endpoints (reachable, key, models) and the models workflows use (probe). */
export interface SetupCheck {
  readonly onDidChange: vscode.Event<void>;
  /** The latest report until dismissed; it is running while finishedAt is undefined. */
  current(): SetupReport | undefined;
  /** Starts a check (or returns the running one) and resolves with the finished report. */
  run(): Promise<SetupReport>;
  dismiss(): void;
}

/* ---------- stores (src/store) ---------- */

export interface AgentRecord {
  summary: AgentSummary;
  /** Lenient parse; null when the file is not a mapping. */
  definition: AgentDefinition | null;
}

export interface CreateAgentOptions {
  /** Exact id (file basename), e.g. the id a workflow block refers to; default: a unique slug of the name. */
  id?: string;
  /** Workspace folder of a workspace agent (multi-root); default: the first folder. */
  folder?: vscode.Uri;
}

export interface AgentStore {
  readonly onDidChange: vscode.Event<void>;
  /** All agents (workspace + user), shadowed user agents flagged. */
  list(): AgentSummary[];
  /** Effective, valid definitions by id (workspace overrides user). */
  definitions(): Record<string, AgentDefinition>;
  get(id: string): AgentRecord | undefined;
  /** Identifies agent files by URI (scope + id), also for files not yet indexed. */
  identify(uri: vscode.Uri): { id: string; scope: AgentScope } | undefined;
  /** Creates `<slug>.agent.yaml` (or `<options.id>.agent.yaml`) and returns its URI. kind picks a starter. */
  create(
    name: string,
    scope: AgentScope,
    kind?: 'blank' | 'coder' | 'reviewer',
    options?: CreateAgentOptions,
  ): Promise<vscode.Uri>;
  delete(uri: vscode.Uri): Promise<void>;
  /**
   * Creates starter agents for these ids in the workspace folder (default: the first one) when no agent with
   * that id exists.
   */
  ensure(ids: ('coder' | 'reviewer')[], folder?: vscode.Uri): Promise<void>;
  dispose(): void;
}

export interface WorkflowStore {
  readonly onDidChange: vscode.Event<void>;
  list(): WorkflowSummary[];
  /**
   * Creates `.isarflow/workflows/<slug>.workflow.yaml` from a template in the workspace folder (default: the
   * first one) and returns its URI.
   */
  create(name: string, template: WorkflowTemplateId, folder?: vscode.Uri): Promise<vscode.Uri>;
  /** Workflows (relative paths) whose blocks reference the agent id. */
  usersOfAgent(agentId: string): string[];
  dispose(): void;
}

/* ---------- runs (src/run) ---------- */

export interface RunHistory {
  readonly onDidChange: vscode.Event<void>;
  list(workflowUri?: string): RunRecordSummary[];
  /** A saved run when it is cached (recent runs); see getAsync for the others. */
  get(runId: string): RunView | undefined;
  /** Reads a saved run from storage when it is not cached. */
  getAsync(runId: string): Promise<RunView | undefined>;
  save(view: RunView, workflowUri: string): Promise<void>;
  /** Stores the review counts of a saved run in its summary ("3 kept, 1 reverted"). */
  setReview?(runId: string, counts: ReviewCounts): Promise<void>;
  /** Fired with the ids of runs removed by the history limit, so their snapshots and worktrees go too. */
  readonly onDidRemove?: vscode.Event<{ workflowUri: string; runIds: string[] }>;
}

/* ---------- run safety: snapshots, edit journal, review (src/safety) ---------- */

/** A changed file between the before and after snapshot of a run. */
export interface SnapshotChange {
  /** Relative to the snapshot root, forward slashes. */
  path: string;
  status: ReviewFileStatus;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

/** Snapshots of one run's folder. */
export interface RunSnapshot {
  runId: string;
  /** Absolute folder the snapshot covers (the workspace folder, or the worktree for worktree runs). */
  root: string;
  coverage: 'git' | 'journal';
  /** Commit stored as refs/isarflow/runs/<runId>/before (git coverage). */
  before?: string;
  /** Commit stored as refs/isarflow/runs/<runId>/after, once the run ended. */
  after?: string;
}

/**
 * Git snapshots with a temporary index (GIT_INDEX_FILE): the user's index, branch, stash and working tree are
 * never touched. Every method logs and degrades instead of throwing where the spec allows it.
 */
export interface SnapshotService {
  /** Snapshots `root` at run start; journal coverage when it is not in a git repository or git fails. */
  begin(runId: string, root: string): Promise<RunSnapshot>;
  /** Snapshots again at run end and lists the changed files (empty for journal coverage). */
  finish(snapshot: RunSnapshot): Promise<{ snapshot: RunSnapshot; changes: SnapshotChange[] }>;
  /** Working-tree bytes (filters and line endings applied) of a file; undefined when it did not exist. */
  read(snapshot: RunSnapshot, side: 'before' | 'after', path: string): Promise<Uint8Array | undefined>;
  /** `git worktree add --detach <path> <before>`; rejects with a user-facing message (e.g. no git). */
  createWorktree(snapshot: RunSnapshot, worktreePath: string): Promise<void>;
  removeWorktree(repoRoot: string, worktreePath: string): Promise<void>;
  /** Deletes refs/isarflow/runs/<runId>/* of runs removed from the history. */
  prune(root: string, runIds: string[]): Promise<void>;
}

export interface EditJournalEntry {
  /** Relative to the run's root, forward slashes. */
  path: string;
  /** Blocks that wrote the file, in order of their first write. */
  stepIds: string[];
  /** False when the first write created the file. */
  existed: boolean;
  /** Whether the content before the first write is stored (size cap; large originals go to git when possible). */
  originalStored: boolean;
  at: number;
}

/** The edit journal of one run. */
export interface EditJournal extends EditJournalWriter {
  readonly runId: string;
  entries(): EditJournalEntry[];
  /** Bytes before the run's first write; null = the file did not exist; undefined = not stored. */
  original(path: string): Promise<Uint8Array | null | undefined>;
}

/** Review state of runs that changed files; implemented in src/safety, owned by the run manager. */
export interface ReviewService {
  /** Fired when a run's review appears or changes (after the run, keep, revert, pruning). */
  readonly onDidChange: vscode.Event<{ runId: string; workflowUri: string }>;
  /** The review of a run; undefined when it changed no files or its data was pruned. */
  get(runId: string): Promise<RunReview | undefined>;
  /** Keeps or reverts files (every pending file when `paths` is omitted); asks before overwriting newer edits. */
  decide(runId: string, decision: 'kept' | 'reverted', paths?: string[]): Promise<void>;
  /** Opens the VS Code diff editor for one file: before the run on the left, after it on the right. */
  openDiff(runId: string, path: string): Promise<void>;
  /** Serves `isarflow-snapshot:` URIs (read-only) for the diff editor. */
  readonly contentProvider: vscode.TextDocumentContentProvider;
}

export interface ApprovalBroker {
  /** Fired when a workflow editor should show an approval prompt. */
  readonly onDidRequest: vscode.Event<ApprovalPrompt & { workflowUri: string }>;
  readonly onDidResolve: vscode.Event<{ requestId: string; workflowUri: string }>;
  /** Asks in the open workflow editor if any is attached, otherwise with a modal dialog. */
  request(prompt: Omit<ApprovalPrompt, 'requestId'> & { workflowUri: string }): Promise<ApprovalResult>;
  respond(requestId: string, result: ApprovalResult): void;
  /** Workflow editors register while visible so approvals can be answered inline. */
  attach(workflowUri: string): vscode.Disposable;
}

export interface ActiveRun {
  runId: string;
  workflowUri: string;
  view: RunView;
}

/* ---------- simulation files (src/simulation) ---------- */

/**
 * The simulation file of each workflow: `<workspace folder>/.isarflow/simulations/<name>.sim.yaml`, where name is
 * the workflow file name without `.workflow.yaml` / `.workflow.yml` (an existing `.sim.yml` is used as well).
 */
export interface SimulationStore {
  /** Fired when a simulation file is created, changed (unsaved edits included) or deleted; `uri` is that file. */
  readonly onDidChange: vscode.Event<{ uri: string }>;
  /** Where the simulation file of a workflow is (or would be). */
  uriFor(workflowUri: vscode.Uri): vscode.Uri;
  /**
   * Reads (an open editor's text first) and checks the file against `workflow` (null: YAML and schema checks
   * only). Never rejects: read errors become an error diagnostic.
   */
  state(workflowUri: vscode.Uri, workflow: Workflow | null): Promise<SimulationState>;
  /**
   * Mocks for a simulated run. Rejects with a user-facing message that names the file and the first error when
   * the file has errors; a missing file gives no mocks.
   */
  load(workflowUri: vscode.Uri): Promise<SimulationFile>;
  /**
   * Replaces the mocks of one block (null or [] removes them), keeping comments and the other blocks; creates the
   * file and its folder when needed. Writes to the same file run one after the other.
   */
  setBlock(workflowUri: vscode.Uri, stepId: string, results: SimulationResult[] | null): Promise<void>;
  /** Moves the mocks of a renamed block to its new id; nothing happens when the file or the block has none. */
  renameBlock(workflowUri: vscode.Uri, oldId: string, newId: string): Promise<void>;
  /** Opens the file beside the active editor, created from a short template when it is missing. */
  open(workflowUri: vscode.Uri): Promise<void>;
  dispose(): void;
}

/* ---------- ask blocks (src/run) ---------- */

/**
 * Questions of ask blocks. Like approvals: inline cards in attached (visible) workflow editors, otherwise a
 * notification whose Answer button opens a QuickPick (choices) or an InputBox (free text).
 */
export interface AskBroker {
  /** Fired when a workflow editor should show an ask card. */
  readonly onDidRequest: vscode.Event<AskPrompt & { workflowUri: string }>;
  readonly onDidResolve: vscode.Event<{ requestId: string; workflowUri: string }>;
  /**
   * Asks and resolves with the answer. Aborting `signal` (the block's timeout, cancel) withdraws the question
   * everywhere and rejects; the engine then uses the default or fails the block. `workflowName` names the
   * workflow in notifications.
   */
  request(
    prompt: Omit<AskPrompt, 'requestId'> & { workflowUri: string; workflowName: string },
    signal?: AbortSignal,
  ): Promise<AskResult>;
  /** An answer from an inline card; ignored for unknown requests and for answers that are not one of the choices. */
  respond(requestId: string, answer: string): void;
  /** Workflow editors register while visible so asks can be answered inline. */
  attach(workflowUri: string): vscode.Disposable;
  /** Asks of this workflow still waiting for an inline answer (for editors that become visible again). */
  pending(workflowUri: string): AskPrompt[];
  /** Withdraws the open asks of a run (the run was cancelled or has ended). */
  cancel(runId: string): void;
}

/* ---------- workflows on code (src/context) ---------- */

/** Captures the expression roots `editor` and `git` when a run starts. */
export interface CodeContextCapture {
  /**
   * The text editor a run started now should see: the active text editor, else the most recently active one that
   * is still visible; undefined when there is none. `root` makes `file` workspace-relative. Synchronous, so
   * commands can capture before they show a QuickPick.
   */
  editor(root: string): EditorContext | undefined;
  /**
   * `git.*` of the folder; never rejects (outside a repository, without git, in untrusted workspaces or when git
   * fails every field is empty).
   */
  git(root: string, signal?: AbortSignal): Promise<GitContext>;
  /** Stops tracking the most recently active editor. */
  dispose(): void;
}

/* ---------- runs: origin, refusals, finished runs ---------- */

/** Why `RunManager.start` did not start a run (passed to RunStartOptions.onRefused). */
export type RunRefusalReason =
  /** Restricted Mode. */
  | 'untrusted'
  /** The workflow is already running (or another start of it is still asking). */
  | 'running'
  /** The file can't be read or has errors. */
  | 'invalid'
  /** Required inputs are missing and this origin never prompts (triggers, Copilot). */
  | 'inputs'
  /** Its commands were never approved and this origin can't ask (triggers), or the user declined. */
  | 'confirmation'
  /** The user cancelled a prompt (inputs). */
  | 'cancelled'
  /** Triggers and Copilot never simulate or resume; resume and simulate together are not possible. */
  | 'not-allowed'
  /** The run manager was disposed, or an unexpected error. */
  | 'error';

export interface RunRefusal {
  reason: RunRefusalReason;
  /** One sentence for people: the text the manager would otherwise show in a notification. */
  message: string;
}

/** Whether a start would need the command confirmation dialog (computed without showing it). */
export type CommandConfirmationState =
  /**
   * Approved before, nothing to confirm and started by a person before, or confirmation turned off
   * (`isarFlow.confirmCommands`).
   */
  | 'approved'
  /** The commands or unattended agents of the current file were never approved. */
  | 'needed'
  /**
   * Nothing to confirm, but no person has started the workflow yet: triggers wait for that one start, so a
   * workflow nobody ever ran (e.g. agents that read the workspace) never starts by itself.
   */
  | 'never-run'
  /** The file can't be read or has errors. */
  | 'invalid';

/** A run that ended and was saved to the history. */
export interface RunFinished {
  runId: string;
  workflowUri: string;
  workflowName: string;
  status: Exclude<RunStatus, 'running'>;
  /** Final view (before history trimming). */
  view: RunView;
  /** Absolute paths of the files the run changed (snapshot diff or edit journal); empty for simulated runs. */
  changedFiles: string[];
  origin: RunOrigin;
  simulated: boolean;
}

/** How a run starts besides the plain "Run". */
export interface RunStartOptions {
  /**
   * Run from here: continue the saved run `runId` of the same workflow at block `stepId`. Blocks before it reuse
   * that run's outputs; `inputs` default to that run's inputs (no prompt).
   */
  resume?: { runId: string; stepId: string };
  /**
   * Test mode: run with the simulation host and the workflow's mocks. No commands, model calls or file changes,
   * so no command confirmation and no snapshots; allowed in Restricted Mode (without secrets).
   */
  simulate?: boolean;
  /**
   * Who starts the run (default manual); recorded in the history. `trigger`: never prompts (inputs = the given
   * values plus defaults; missing required inputs or unapproved commands are refused). `copilot`: never shows
   * input boxes (missing required inputs are refused) but shows the command confirmation as usual. Neither may
   * simulate or resume ('not-allowed').
   */
  origin?: RunOrigin;
  /** `editor.*` captured earlier (Run workflow on selection captures it before its QuickPick); default: at start. */
  editor?: EditorContext;
  /**
   * Called instead of a notification when the run does not start (refusals and cancelled prompts). Without it the
   * manager shows its usual notifications.
   */
  onRefused?(refusal: RunRefusal): void;
}

export interface RunManager {
  readonly onEvent: vscode.Event<{ workflowUri: string; event: RunEvent }>;
  readonly onDidChangeRuns: vscode.Event<void>;
  readonly history: RunHistory;
  readonly approvals: ApprovalBroker;
  /** Review of runs that changed files; always set by createRunManager. */
  readonly reviews?: ReviewService;
  /** Simulation files of the workflows; always set by createRunManager. */
  readonly simulations?: SimulationStore;
  /** Questions of ask blocks; always set by createRunManager. */
  readonly asks?: AskBroker;
  /** Fired after a run ended and was saved to the history (simulated runs too); always set by createRunManager. */
  readonly onDidFinish?: vscode.Event<RunFinished>;
  /**
   * Validates, asks for missing inputs (input boxes) when `inputs` is undefined, confirms console commands
   * when needed, then runs. Returns the run id, or undefined when the user cancelled or validation failed.
   * `options` starts a run from a block of a saved run or a simulated run, and says who starts it.
   */
  start(
    workflowUri: vscode.Uri,
    inputs?: Record<string, unknown>,
    options?: RunStartOptions,
  ): Promise<string | undefined>;
  cancel(runId: string): void;
  active(workflowUri?: string): ActiveRun[];
  /** Resolves with the final view once the run has ended (from history for runs that already ended). */
  whenFinished?(runId: string): Promise<RunView | undefined>;
  /** Whether starting the workflow now would show the command confirmation; never shows a dialog. */
  confirmationState?(workflowUri: vscode.Uri): Promise<CommandConfirmationState>;
  dispose(): void;
}

/* ---------- triggers (src/triggers) ---------- */

/** Watches the `on:` triggers of all workflows and starts runs (origin trigger). */
export interface TriggerService {
  /** Fired when a workflow's trigger state changes (`workflowUri` in string form). */
  readonly onDidChange: vscode.Event<{ workflowUri: string }>;
  /** Current state of a workflow's triggers (no triggers: empty list, status active). */
  state(workflowUri: string): WorkflowTriggerState;
  /** Workflows with at least one trigger, for the status bar. */
  list(): { workflowUri: string; name: string; state: WorkflowTriggerState }[];
  /** Turns a workflow's triggers on again after they were paused for starting too often ('limited'). */
  resume(workflowUri: string): void;
  dispose(): void;
}

/** What createTriggerService (src/triggers/triggerService.ts) needs; extension.ts passes the real services. */
export interface TriggerServiceDeps {
  runs: Pick<RunManager, 'start' | 'active' | 'onDidChangeRuns' | 'onDidFinish' | 'confirmationState'> & {
    reviews?: Pick<ReviewService, 'onDidChange' | 'get'>;
  };
  workflows: Pick<WorkflowStore, 'list' | 'onDidChange'>;
  log: vscode.LogOutputChannel;
}

/** What createMemoryService (src/memory/memoryService.ts) needs. */
export interface MemoryServiceDeps {
  log: vscode.LogOutputChannel;
}

/* ---------- project memory (src/memory) ---------- */

/** `.isarflow/memory.md` of each workspace folder. */
export interface MemoryService {
  /** Fired when a memory file is created, changed (unsaved edits included) or deleted. */
  readonly onDidChange: vscode.Event<void>;
  /** The memory file of every workspace folder, in folder order. */
  files(): MemoryFileState[];
  /** The memory file of the folder that contains `uri` (agent or workflow file), else of the first folder. */
  stateFor(uri: vscode.Uri): MemoryFileState | undefined;
  /** Opens the file of the folder (default: the first), created with a short header when missing. */
  open(folderUri?: vscode.Uri): Promise<void>;
  /**
   * The memory of workspace folder `root` for one run. `read`: an open editor's text first. `append`: queued per
   * file; an open document gets a WorkspaceEdit and is saved when it was not dirty; refuses notes that contain
   * one of `secrets`; tells `journal` before writing so the review card lists the change.
   */
  forRun(root: string, options: { journal?: EditJournalWriter; secrets?: string[] }): ProjectMemory;
  dispose(): void;
}

/* ---------- shared services passed to UI providers ---------- */

export interface Services {
  context: vscode.ExtensionContext;
  agents: AgentStore;
  workflows: WorkflowStore;
  models: ModelRegistry;
  runs: RunManager;
  /** Tool hosts for agents (workspace-bounded, permission-gated). */
  tools: ToolHostFactory;
  output: vscode.LogOutputChannel;
  /** "Check setup"; set by extension.ts. */
  setupCheck?: SetupCheck;
  /** `on:` triggers; set by extension.ts. */
  triggers?: TriggerService;
  /** Project memory files; set by extension.ts. */
  memory?: MemoryService;
  /** `editor.*` / `git.*` capture; set by extension.ts. */
  codeContext?: CodeContextCapture;
}

/**
 * Process-level dependencies injected into the run manager (src/run) so it never imports the runner or
 * tool modules directly; src/extension.ts passes the real implementations, tests pass fakes.
 */
export interface RunManagerDeps {
  context: vscode.ExtensionContext;
  models: ModelRegistry;
  agents: AgentStore;
  log: vscode.LogOutputChannel;
  runCommand: RunConsoleCommand;
  tools: ToolHostFactory;
  /** Returns the shared mirror terminal for a workflow (created on first use). */
  terminalFor(workflowName: string): RunTerminal;
  /** Reads files matching workspace-relative globs for `context.files` (capped). */
  readContextFiles(globs: string[], signal: AbortSignal): Promise<{ path: string; content: string }[]>;
  /** Captures `editor.*` and `git.*` at run start; without it both roots are empty. */
  codeContext?: CodeContextCapture;
  /** Project memory for agents (memory read/write); without it agents run without memory. */
  memory?: MemoryService;
}
