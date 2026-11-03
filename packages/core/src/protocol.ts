/**
 * Messages between the extension host and the webviews. Every webview first posts `{ type: 'ready' }`;
 * the host answers with the full state for that view.
 */
import type { Diagnostic } from './diagnostics';
import type { RunEvent, RunStatus, Usage } from './engine/types';
import type { ChatModelInfo, ModelErrorKind, ModelProbeResult } from './models/types';
import type { BlockRunMetrics, RunView } from './run/types';
import type {
  AgentDefinition,
  AgentPermissions,
  ToolName,
  Workflow,
  WorkflowIsolation,
} from './schema/types';
import type { WorkflowOp } from './yaml/types';

export type WebviewKind = 'sidebar' | 'workflow' | 'agent';

/* ---------- shared data ---------- */

export type AgentScope = 'workspace' | 'user';

export interface AgentSummary {
  /** File basename without `.agent.yaml`; used as `agent:` reference in workflows. */
  id: string;
  name: string;
  description?: string;
  model: string;
  tools: ToolName[];
  /** Permission levels from the file, for the capability badges (see agentCapabilities). */
  permissions?: AgentPermissions;
  scope: AgentScope;
  /** File URI (string form). */
  uri: string;
  valid: boolean;
  /** True when a workspace agent with the same id hides this user agent. */
  shadowed?: boolean;
}

/* ---------- run review (snapshots, edit journal, keep / revert) ---------- */

export type ReviewFileStatus = 'added' | 'modified' | 'deleted';

/**
 * pending: not decided yet. kept: the change stays (worktree runs: it was applied to the workspace).
 * reverted: the file is back in its state before the run (worktree runs: the change was dropped).
 * Decisions are final.
 */
export type ReviewDecision = 'pending' | 'kept' | 'reverted';

export interface ReviewFile {
  /** Path relative to the workspace folder, with forward slashes. */
  path: string;
  status: ReviewFileStatus;
  /** Added and removed lines; undefined for binary files. */
  additions?: number;
  deletions?: number;
  binary?: boolean;
  /** Blocks whose agent tools wrote the file, in order of their first write; empty = changed by a command. */
  stepIds: string[];
  decision: ReviewDecision;
  /**
   * Whether Revert is possible: false when the state before the run is unknown (no git and the original was too
   * large to keep, or a symbolic link).
   */
  revertible: boolean;
  /** Why the last keep or revert of this file failed; cleared by the next attempt. */
  error?: string;
}

/** Files a run changed and what the user decided about them. */
export interface RunReview {
  runId: string;
  /**
   * git: before/after snapshots of the folder cover agents and console commands. journal: the folder is not a
   * git repository (or the snapshot failed), so only files that agent tools wrote are listed.
   */
  coverage: 'git' | 'journal';
  isolation: WorkflowIsolation;
  /** Changed files, sorted by path; capped at 500 (see `omitted`). */
  files: ReviewFile[];
  /** Changed files not listed because of the cap; Keep all and Revert all include them. */
  omitted?: number;
  /** How many of the `omitted` files are still pending; left out when none are. */
  omittedPending?: number;
  /** Worktree runs: false once the worktree was removed, so pending files can no longer be applied. */
  worktreeAvailable?: boolean;
  /** Another run worked in the same folder at the same time, so the list may include its changes. */
  overlapping?: boolean;
  /** True while keep or revert is being applied. */
  busy?: boolean;
}

export interface ReviewCounts {
  total: number;
  kept: number;
  reverted: number;
  pending: number;
}

export interface RunRecordSummary {
  runId: string;
  workflowUri: string;
  workflowName: string;
  status: RunStatus;
  startedAt: number;
  durationMs?: number;
  error?: string;
  usage?: Usage;
  /** Per-block numbers for trends (runs saved before Package A have none). */
  blocks?: Record<string, BlockRunMetrics>;
  /** Review state when the run changed files, e.g. for "3 kept, 1 reverted". */
  review?: ReviewCounts;
}

export interface WorkflowSummary {
  uri: string;
  name: string;
  description?: string;
  /** Path relative to the workspace folder, with forward slashes. */
  relativePath: string;
  valid: boolean;
  stepCount: number;
  lastRun?: RunRecordSummary;
}

export type ProviderKind = 'vscode' | 'openai-compatible';

export interface ProviderSummary {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  hasApiKey: boolean;
  status: 'ok' | 'error' | 'loading' | 'unknown';
  error?: string;
  /** Why listing the models failed (status 'error'), so the setup check can offer the right fix. */
  errorKind?: ModelErrorKind;
  modelCount: number;
}

/** Price per 1 million tokens (setting `isarFlow.modelPrices`, keyed by model reference). */
export interface ModelPrice {
  input: number;
  output: number;
}

export type ModelPrices = Record<string, ModelPrice>;

export interface ModelCatalog {
  models: ChatModelInfo[];
  providers: ProviderSummary[];
  loading: boolean;
  /** Cached "Test model" results by model reference (also for models that are not listed). */
  probes?: Record<string, ModelProbeResult>;
  /** Model references whose test is running now. */
  probing?: string[];
  /** Valid entries of `isarFlow.modelPrices`; costs are shown only for models listed here. */
  prices?: ModelPrices;
}

/* ---------- setup check ---------- */

export type SetupCheckStatus = 'ok' | 'warning' | 'error' | 'running' | 'skipped';

/** A button of the setup report: the sidebar posts `message` as it is. */
export interface SetupFix {
  label: string;
  message: SidebarToHost;
}

export interface SetupCheckItem {
  /** Stable key, e.g. "endpoint:litellm" or "model:litellm/gpt-4.1". */
  id: string;
  kind: 'endpoint' | 'model';
  /** Endpoint label or model reference. */
  label: string;
  status: SetupCheckStatus;
  /** One sentence: what was found, e.g. "Reachable, 12 models" or "The API key was rejected." */
  message: string;
  /** Model items: agent ids and workflow paths that use the model. */
  usedBy?: string[];
  fix?: SetupFix;
}

export interface SetupReport {
  startedAt: number;
  /** Undefined while the check runs. */
  finishedAt?: number;
  items: SetupCheckItem[];
}

export type WorkflowTemplateId = 'blank' | 'review-loop' | 'test-fix';

/* ---------- sidebar ---------- */

export type SidebarTab = 'agents' | 'workflows';

/** A run that is in progress right now. */
export interface ActiveRunSummary {
  runId: string;
  workflowUri: string;
  workflowName: string;
  startedAt: number;
}

export interface SidebarState {
  hasWorkspace: boolean;
  trusted: boolean;
  agents: AgentSummary[];
  workflows: WorkflowSummary[];
  catalog: ModelCatalog;
  /** Finished runs, newest first. Running runs are listed in `activeRuns`. */
  recentRuns: RunRecordSummary[];
  activeRuns: ActiveRunSummary[];
  tab: SidebarTab;
  /** Latest "Check setup" report (running or finished) until dismissed; null or missing = none. */
  setupCheck?: SetupReport | null;
}

export type AgentStarter = 'blank' | 'coder' | 'reviewer';

/**
 * Destructive sidebar actions (deleteAgent, removeProvider) are confirmed inline in the webview,
 * so the host performs them without a second confirmation dialog.
 */
export type SidebarToHost =
  | { type: 'ready' }
  | { type: 'setTab'; tab: SidebarTab }
  | { type: 'openAgent'; uri: string }
  | { type: 'createAgent'; name: string; scope: AgentScope; starter?: AgentStarter }
  | { type: 'deleteAgent'; uri: string }
  | { type: 'openWorkflow'; uri: string }
  | { type: 'createWorkflow'; name: string; template: WorkflowTemplateId }
  | { type: 'runWorkflow'; uri: string }
  | { type: 'cancelRun'; runId: string }
  | { type: 'openRun'; runId: string; workflowUri: string }
  | { type: 'addProvider' }
  | { type: 'editProvider'; providerId: string }
  | { type: 'setProviderKey'; providerId: string }
  | { type: 'removeProvider'; providerId: string }
  | { type: 'refreshModels' }
  /** Runs "Test model" for `ref`, or lets the user pick one of the provider's models. */
  | { type: 'testModel'; providerId?: string; ref?: string }
  /** Runs "Check setup"; the report arrives in SidebarState.setupCheck. */
  | { type: 'checkSetup' }
  | { type: 'dismissSetupCheck' }
  /** Opens the VS Code settings filtered by `query`, e.g. "isarFlow.providers" (setup report fixes). */
  | { type: 'openSettings'; query: string };

export type HostToSidebar = { type: 'state'; state: SidebarState };

/* ---------- workflow editor ---------- */

export interface WorkflowDocumentState {
  uri: string;
  fileName: string;
  text: string;
  workflow: Workflow | null;
  /** Schema-valid and free of semantic errors. */
  valid: boolean;
  /** Parse, schema and semantic diagnostics. */
  diagnostics: Diagnostic[];
}

export interface ApprovalPrompt {
  requestId: string;
  runId: string;
  stepId: string;
  message: string;
}

export type WorkflowEditorToHost =
  | { type: 'ready' }
  | { type: 'ops'; ops: WorkflowOp[] }
  | { type: 'run'; inputs: Record<string, unknown> }
  | { type: 'cancelRun' }
  /** Shows a past run (or the live one when null) on the canvas. */
  | { type: 'selectRun'; runId: string | null }
  | { type: 'approval'; requestId: string; approved: boolean; comment?: string }
  /** Opens the YAML text editor beside the canvas, revealing the block when given. */
  | { type: 'openYaml'; stepId?: string }
  | { type: 'openAgent'; agentId: string }
  | { type: 'createAgent' }
  | { type: 'refreshModels' }
  | { type: 'copyToClipboard'; text: string }
  /**
   * Keeps or reverts files of a run's review (`paths` omitted = every pending file, listed or not). The host asks
   * before overwriting files that changed after the run.
   */
  | { type: 'reviewFiles'; runId: string; decision: 'kept' | 'reverted'; paths?: string[] }
  /** Opens the VS Code diff editor for one reviewed file (before the run on the left). */
  | { type: 'openReviewDiff'; runId: string; path: string };

export type HostToWorkflowEditor =
  | { type: 'document'; doc: WorkflowDocumentState }
  | { type: 'catalog'; agents: AgentSummary[]; catalog: ModelCatalog }
  | { type: 'trust'; trusted: boolean }
  /** Full snapshot of the run shown on the canvas (live or historical); null clears it. */
  | { type: 'run'; run: RunView | null; live: boolean }
  /** Incremental event for the live run; apply with reduceRunEvent. */
  | { type: 'runEvent'; event: RunEvent }
  | { type: 'history'; runs: RunRecordSummary[] }
  | { type: 'approvalRequest'; prompt: ApprovalPrompt }
  | { type: 'approvalResolved'; requestId: string }
  | { type: 'opsFailed'; error: string }
  /** Asks the canvas to select and reveal a block (e.g. from a CodeLens or diagnostic). */
  | { type: 'focusStep'; stepId: string }
  /**
   * Review of the run shown on the canvas, sent after every `run` message and whenever the review changes;
   * null when that run changed no files or its review data was removed with the history.
   */
  | { type: 'review'; review: RunReview | null };

/* ---------- agent editor ---------- */

export interface AgentDocumentState {
  uri: string;
  id: string;
  scope: AgentScope;
  fileName: string;
  text: string;
  agent: AgentDefinition | null;
  valid: boolean;
  diagnostics: Diagnostic[];
  /** Workflows (relative paths) that reference this agent id. */
  usedBy: string[];
}

export type TryItEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; args: string; result?: string; isError?: boolean }
  | { type: 'done'; usage: Usage; model: string }
  | { type: 'error'; message: string };

export type AgentEditorToHost =
  | { type: 'ready' }
  /** Sets top-level keys of the agent file (comment-preserving); `unset` removes keys. */
  | { type: 'update'; set: Partial<AgentDefinition>; unset?: string[] }
  | { type: 'tryIt'; prompt: string; history: { role: 'user' | 'assistant'; content: string }[] }
  | { type: 'cancelTryIt' }
  | { type: 'openYaml' }
  | { type: 'refreshModels' }
  | { type: 'addProvider' }
  /** Opens a workflow from the "Used by" list; `path` is one of AgentDocumentState.usedBy. */
  | { type: 'openWorkflow'; path: string }
  /** Runs "Test model" for a model reference; progress and result arrive in the catalog (probing / probes). */
  | { type: 'testModel'; ref: string };

export type HostToAgentEditor =
  | { type: 'document'; doc: AgentDocumentState }
  | { type: 'catalog'; catalog: ModelCatalog }
  | { type: 'tryItEvent'; event: TryItEvent }
  | { type: 'updateFailed'; error: string };
