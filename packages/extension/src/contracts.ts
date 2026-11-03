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
  ChatModel,
  ConsoleResult,
  ModelCatalog,
  ModelProbeResult,
  ModelResolver,
  ReviewCounts,
  ReviewFileStatus,
  RunEvent,
  RunRecordSummary,
  RunReview,
  RunView,
  SetupReport,
  ShellName,
  SimulationFile,
  SimulationResult,
  SimulationState,
  ToolHost,
  ToolName,
  Workflow,
  WorkflowSummary,
  WorkflowTemplateId,
} from '@isar-flow/core';

/* ---------- console runner (src/runner) ---------- */

export interface ConsoleRunOptions {
  command: string;
  shell: ShellName;
  /** Absolute working directory. */
  cwd: string;
  /** Added on top of process.env. */
  env: Record<string, string>;
  timeoutMs?: number;
  signal: AbortSignal;
  onData(stream: 'stdout' | 'stderr', text: string): void;
}

/** Spawns the command in the resolved shell, captures output (UTF-8), kills the process tree on abort/timeout. */
export type RunConsoleCommand = (options: ConsoleRunOptions) => Promise<ConsoleResult>;

export interface ResolvedShell {
  /** Executable, e.g. 'pwsh.exe', 'powershell.exe', 'cmd.exe', '/bin/bash'. */
  file: string;
  args(command: string): string[];
  label: string;
}

/** A terminal tab that mirrors run output live ("Isar Flow: <workflow>"). */
export interface RunTerminal {
  write(text: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

/* ---------- agent tools (src/tools) ---------- */

/** File access used by the tool host; the VS Code implementation applies edits via WorkspaceEdit (undoable). */
export interface WorkspaceAdapter {
  readFile(absPath: string): Promise<string>;
  /** Creates or overwrites a file. */
  writeFile(absPath: string, content: string): Promise<void>;
  /** Workspace-relative paths (forward slashes) matching the glob, excluding node_modules/.git, at most `max`. */
  findFiles(glob: string, max: number): Promise<string[]>;
  /** Resolves symlinks; rejects when the path does not exist. */
  realPath(absPath: string): Promise<string>;
  exists(absPath: string): Promise<boolean>;
  /** Deletes a file as an undoable workspace edit; used by applyPatch for "+++ /dev/null". */
  deleteFile?(absPath: string): Promise<void>;
}

/**
 * Receives agent writes from the tool host for the run's edit journal (review card: which block changed which
 * file; the original content when the folder has no git).
 */
export interface EditJournalWriter {
  /**
   * Called before an agent tool creates, changes or deletes `absPath`. The journal reads the file as it is on disk
   * now, but only the first time per file and run. `unsaved` is the text of an editor with unsaved changes to the
   * file: the write saves it, so it is kept instead. Never rejects: storage problems are logged.
   */
  beforeWrite(absPath: string, stepId: string, unsaved?: string): Promise<void>;
}

/** Per-run extras of a tool host. */
export interface ToolHostRunOptions {
  /** Records agent writes; omitted for Try it. */
  journal?: EditJournalWriter;
}

export interface PermissionRequest {
  runId: string;
  stepId: string;
  tool: ToolName;
  /** One line, e.g. "Edit src/app.ts" or "Run: npm test". */
  summary: string;
  detail?: string;
}

/** 'allowRun' allows this tool for the rest of the run. */
export type PermissionAnswer = 'allow' | 'allowRun' | 'deny';

export type PermissionPrompt = (request: PermissionRequest) => Promise<PermissionAnswer>;

export interface ToolHostOptions {
  workspaceRoot: string;
  workspace: WorkspaceAdapter;
  runCommand: RunConsoleCommand;
  prompt: PermissionPrompt;
  defaultShell: ShellName;
  /** Told about every agent write before it happens (runs only). */
  journal?: EditJournalWriter;
}

/**
 * Creates a tool host whose "allow for this run" answers are scoped to `runId`. `workspaceRoot` is the
 * folder of the workflow being run (multi-root workspaces) or the run's git worktree; defaults to the first
 * workspace folder. Roots outside the workspace folders (worktrees in extension storage) must work too.
 */
export type ToolHostFactory = (
  runId: string,
  workspaceRoot?: string,
  options?: ToolHostRunOptions,
) => ToolHost;

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
  /**
   * Validates, asks for missing inputs (input boxes) when `inputs` is undefined, confirms console commands
   * when needed, then runs. Returns the run id, or undefined when the user cancelled or validation failed.
   * `options` starts a run from a block of a saved run, or a simulated run.
   */
  start(
    workflowUri: vscode.Uri,
    inputs?: Record<string, unknown>,
    options?: RunStartOptions,
  ): Promise<string | undefined>;
  cancel(runId: string): void;
  active(workflowUri?: string): ActiveRun[];
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
}
