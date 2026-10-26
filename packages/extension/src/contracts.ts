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
  ModelResolver,
  RunEvent,
  RunRecordSummary,
  RunView,
  ShellName,
  ToolHost,
  ToolName,
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
}

/** Creates a tool host whose "allow for this run" answers are scoped to `runId`. */
export type ToolHostFactory = (runId: string) => ToolHost;

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
  resolve(ref: string): Promise<ChatModel>;
  dispose(): void;
}

/* ---------- stores (src/store) ---------- */

export interface AgentRecord {
  summary: AgentSummary;
  /** Lenient parse; null when the file is not a mapping. */
  definition: AgentDefinition | null;
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
  /** Creates `<slug>.agent.yaml` and returns its URI. kind picks a starter definition. */
  create(name: string, scope: AgentScope, kind?: 'blank' | 'coder' | 'reviewer'): Promise<vscode.Uri>;
  delete(uri: vscode.Uri): Promise<void>;
  /** Creates starter agents for these ids in the workspace when no agent with that id exists. */
  ensure(ids: ('coder' | 'reviewer')[]): Promise<void>;
  dispose(): void;
}

export interface WorkflowStore {
  readonly onDidChange: vscode.Event<void>;
  list(): WorkflowSummary[];
  /** Creates `.isarflow/workflows/<slug>.workflow.yaml` from a template and returns its URI. */
  create(name: string, template: WorkflowTemplateId): Promise<vscode.Uri>;
  /** Workflows (relative paths) whose blocks reference the agent id. */
  usersOfAgent(agentId: string): string[];
  dispose(): void;
}

/* ---------- runs (src/run) ---------- */

export interface RunHistory {
  readonly onDidChange: vscode.Event<void>;
  list(workflowUri?: string): RunRecordSummary[];
  get(runId: string): RunView | undefined;
  save(view: RunView, workflowUri: string): Promise<void>;
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

export interface RunManager {
  readonly onEvent: vscode.Event<{ workflowUri: string; event: RunEvent }>;
  readonly onDidChangeRuns: vscode.Event<void>;
  readonly history: RunHistory;
  readonly approvals: ApprovalBroker;
  /**
   * Validates, asks for missing inputs (input boxes) when `inputs` is undefined, confirms console commands
   * when needed, then runs. Returns the run id, or undefined when the user cancelled or validation failed.
   */
  start(workflowUri: vscode.Uri, inputs?: Record<string, unknown>): Promise<string | undefined>;
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
