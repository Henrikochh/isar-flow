/**
 * Messages between the extension host and the webviews. Every webview first posts `{ type: 'ready' }`;
 * the host answers with the full state for that view.
 */
import type { Diagnostic } from './diagnostics';
import type { RunEvent, RunStatus, Usage } from './engine/types';
import type { ChatModelInfo } from './models/types';
import type { RunView } from './run/types';
import type { AgentDefinition, ToolName, Workflow } from './schema/types';
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
  scope: AgentScope;
  /** File URI (string form). */
  uri: string;
  valid: boolean;
  /** True when a workspace agent with the same id hides this user agent. */
  shadowed?: boolean;
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
  modelCount: number;
}

export interface ModelCatalog {
  models: ChatModelInfo[];
  providers: ProviderSummary[];
  loading: boolean;
}

export type WorkflowTemplateId = 'blank' | 'review-loop' | 'test-fix';

/* ---------- sidebar ---------- */

export type SidebarTab = 'agents' | 'workflows';

export interface SidebarState {
  hasWorkspace: boolean;
  trusted: boolean;
  agents: AgentSummary[];
  workflows: WorkflowSummary[];
  catalog: ModelCatalog;
  recentRuns: RunRecordSummary[];
  activeRuns: string[];
  tab: SidebarTab;
}

export type SidebarToHost =
  | { type: 'ready' }
  | { type: 'setTab'; tab: SidebarTab }
  | { type: 'openAgent'; uri: string }
  | { type: 'createAgent'; name: string; scope: AgentScope }
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
  | { type: 'refreshModels' };

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
  | { type: 'copyToClipboard'; text: string };

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
  | { type: 'focusStep'; stepId: string };

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
  | { type: 'addProvider' };

export type HostToAgentEditor =
  | { type: 'document'; doc: AgentDocumentState }
  | { type: 'catalog'; catalog: ModelCatalog }
  | { type: 'tryItEvent'; event: TryItEvent }
  | { type: 'updateFailed'; error: string };
