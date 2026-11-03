import type { Condition } from '../conditions';

export type StepType = 'agent' | 'console' | 'loop' | 'if' | 'break' | 'stop' | 'approval' | 'ask';

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

/**
 * Project memory (`.isarflow/memory.md` of the run's workspace folder). `read` (default): the file (at most 8 KB)
 * is added to the system prompt. `write`: also offers the tool `remember(note)`, which appends a dated bullet.
 * `none`: the agent never sees the file.
 */
export type MemoryMode = 'none' | 'read' | 'write';

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
  /** Project memory access (default read). */
  memory?: MemoryMode;
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

/**
 * Asks the user a question and waits for the answer (`steps.<id>.answer`). With `choices` the answer is one of
 * them; without, it is free text. The common `timeout` limits the wait: then `default` is used when set (output
 * `timedOut: true`), otherwise the block fails.
 */
export interface AskStep extends StepBase {
  type: 'ask';
  /** Supports ${{ }} templates. */
  question: string;
  /** Allowed answers (templates allowed); free text when omitted. */
  choices?: string[];
  /** Preselected answer; also used on timeout and by `--yes` on the command line. Templates allowed. */
  default?: string;
}

export type Step =
  AgentStep | ConsoleStep | LoopStep | IfStep | BreakStep | StopStep | ApprovalStep | AskStep;

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

/**
 * Workspace-relative glob(s) with forward slashes, e.g. `docs/**` or `src/*.ts`. In a list, patterns starting
 * with `!` exclude files that the other patterns match.
 */
export type TriggerFiles = string | string[];

/**
 * Workflow key `on:`: when VS Code starts the workflow by itself. Triggers only fire while VS Code is open, in
 * trusted workspaces, for workflows whose commands were approved once (confirmation hash), and while the setting
 * `isarFlow.triggers.enabled` is on.
 */
export interface WorkflowTriggers {
  /** A text document matching `files` was saved in VS Code. */
  save?: { files: TriggerFiles };
  /** A file matching `files` was created, changed or deleted on disk (by any program). */
  change?: { files: TriggerFiles };
  /** Every `every` while VS Code is open, e.g. "15m", "1h", "1h30m", "1d" (at least 1m). */
  schedule?: { every: string };
}

export type TriggerKind = keyof WorkflowTriggers;

export interface Workflow {
  version: 1;
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInput>;
  env?: Record<string, string>;
  isolation?: WorkflowIsolation;
  /** Commands run in the worktree before the first block (only with `isolation: worktree`), e.g. `npm ci`. */
  setup?: string[];
  /** Triggers that start the workflow automatically (save, change, schedule). */
  on?: WorkflowTriggers;
  /** Copilot (language model tools and the @isarflow chat participant) may run this workflow. Default false. */
  expose?: boolean;
  steps: Step[];
}

export type StepSlot = 'steps' | 'then' | 'else';

/* ---------- simulation file (.isarflow/simulations/<workflow>.sim.yaml) ---------- */

/**
 * One mocked host call of a block in a simulated run. Only the fields of the block's type apply (console:
 * exitCode, output; agent: text, json; approval: approved, comment; ask: answer); `error` fails the call for any
 * of them.
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
  /** Ask: the answer (default: the block's default, else its first choice, else "(simulated answer)"). */
  answer?: string;
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

/* ---------- project config (.isarflow/config.yaml, read by the command line runner) ---------- */

/**
 * An OpenAI-compatible endpoint for `isar-flow run`. The API key never lives in the file: it is read from the
 * environment variable named by `apiKeyEnv` (default `ISARFLOW_<ID>_API_KEY`: the id upper-cased, `-` as `_`).
 */
export interface ProjectProviderConfig {
  /** Provider id, the first part of model refs (`<id>/<model>`); `vscode` is reserved. */
  id: string;
  label?: string;
  /** API root, e.g. `http://localhost:4000/v1`. */
  baseUrl: string;
  /** Name of the environment variable that holds the API key. */
  apiKeyEnv?: string;
  /** Ask the server for its models via `GET /models` (default true). */
  discoverModels?: boolean;
  /** Models offered in addition to (or, without discovery, instead of) the discovered ones. */
  models?: string[];
  headers?: Record<string, string>;
}

/** Contents of `.isarflow/config.yaml` (command line runner settings; VS Code uses its own settings). */
export interface ProjectConfig {
  version?: 1;
  providers?: ProjectProviderConfig[];
}
