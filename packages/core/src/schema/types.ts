import type { Condition } from '../conditions';

export type StepType = 'agent' | 'console' | 'loop' | 'if' | 'break' | 'stop' | 'approval';

export type ToolName =
  | 'readFile'
  | 'listFiles'
  | 'searchText'
  | 'gitDiff'
  | 'editFile'
  | 'applyPatch'
  | 'writeFile'
  | 'runCommand';

export type PermissionLevel = 'none' | 'ask' | 'auto';

export type ShellName = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'sh';

export interface AgentPermissions {
  edits?: PermissionLevel;
  commands?: PermissionLevel;
}

/**
 * How an agent calls tools. `auto` (default): native tool calls when the model supports them, otherwise `text`;
 * tool calls the model writes as text are repaired. `native`: native tool calls only. `text`: the tools are
 * described in the prompt and the model writes its calls as text (for models without native tool calling).
 */
export type ToolMode = 'auto' | 'native' | 'text';

/** Agent settings shared by agent files and inline agents in workflow steps. */
export interface AgentSettings {
  model?: string;
  fallbackModels?: string[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  tools?: ToolName[];
  toolMode?: ToolMode;
  permissions?: AgentPermissions;
}

/** Contents of `.isarflow/agents/<id>.agent.yaml`. */
export interface AgentDefinition extends AgentSettings {
  name: string;
  description?: string;
  model: string;
}

/**
 * Expected JSON shape of an agent answer. Either a compact shape (`{ approved: boolean, issues: "string[]" }`)
 * or a full JSON Schema object. It counts as JSON Schema (see isJsonSchema) when it has a `properties` object,
 * or when its `type` is a JSON Schema type name (or a non-empty list of them) and every other key is a known
 * JSON Schema keyword; anything else is read as a compact shape, so `{ type: string }` is a schema for a
 * string while `{ type: string, size: number }` is a compact shape with the keys `type` and `size`.
 */
export type OutputShape = Record<string, unknown>;

export interface StepBase {
  id: string;
  name?: string;
  /** Seconds. */
  timeout?: number;
  continueOnError?: boolean;
  retry?: { max: number; delay?: number };
}

export interface AgentStep extends StepBase {
  type: 'agent';
  agent?: string | AgentSettings;
  model?: string;
  prompt: string;
  output?: { format: 'text' | 'json'; schema?: OutputShape };
  session?: 'fresh' | 'continue';
  context?: { files?: string[] };
}

export interface ConsoleStep extends StepBase {
  type: 'console';
  run: string;
  shell?: ShellName;
  cwd?: string;
  env?: Record<string, string>;
}

export interface LoopStep extends StepBase {
  type: 'loop';
  until?: Condition;
  while?: Condition;
  maxIterations: number;
  onMaxIterations?: 'fail' | 'continue';
  steps: Step[];
}

export interface IfStep extends StepBase {
  type: 'if';
  condition: Condition;
  then: Step[];
  else?: Step[];
}

export interface BreakStep extends StepBase {
  type: 'break';
}

export interface StopStep extends StepBase {
  type: 'stop';
  outcome?: 'success' | 'failure';
  message?: string;
}

export interface ApprovalStep extends StepBase {
  type: 'approval';
  message: string;
  onReject?: 'stop' | 'continue';
}

export type Step = AgentStep | ConsoleStep | LoopStep | IfStep | BreakStep | StopStep | ApprovalStep;

export type StepOfType<T extends StepType> = Extract<Step, { type: T }>;

export interface WorkflowInput {
  type?: 'string' | 'number' | 'boolean';
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  multiline?: boolean;
}

/**
 * Where a run changes files. `workspace` (default): in the workspace folder itself. `worktree` (git only): in a
 * git worktree checked out at the run's before snapshot; the review card applies kept files to the workspace.
 */
export type WorkflowIsolation = 'workspace' | 'worktree';

export interface Workflow {
  version: 1;
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInput>;
  env?: Record<string, string>;
  isolation?: WorkflowIsolation;
  /** Commands run in the worktree before the first block (only with `isolation: worktree`), e.g. `npm ci`. */
  setup?: string[];
  steps: Step[];
}

export type StepSlot = 'steps' | 'then' | 'else';

/* ---------- simulation file (.isarflow/simulations/<workflow>.sim.yaml) ---------- */

/**
 * One mocked host call of a block in a simulated run. Only the fields of the block's type apply (console:
 * exitCode, output; agent: text, json; approval: approved, comment); `error` fails the call for any of them.
 */
export interface SimulationResult {
  /** Console: exit code (default 0). */
  exitCode?: number;
  /** Console: what the command printed (default empty). */
  output?: string;
  /** Agent: the answer text (default "(simulated answer)"; for JSON answers the JSON as text). */
  text?: string;
  /** Agent with a JSON answer: the answer (default: sample JSON built from the block's JSON fields). */
  json?: unknown;
  /** Approval: the decision (default from the file's `approvals`). */
  approved?: boolean;
  /** Approval: the comment that comes with the decision. */
  comment?: string;
  /** Fails this call with the message, e.g. to simulate an unreachable model. */
  error?: string;
}

/** How approval blocks without mocks are answered in simulated runs. */
export type SimulationApprovals = 'approve' | 'reject';

/** Contents of a simulation file: mocks for Simulate. */
export interface SimulationFile {
  version?: 1;
  /** Answer for approval blocks without mocks (default approve). */
  approvals?: SimulationApprovals;
  /** Results per block id, used in order; the last one repeats. */
  blocks?: Record<string, SimulationResult[]>;
}
