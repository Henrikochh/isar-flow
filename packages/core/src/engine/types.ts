import type { ChatMessage } from '../models/types';
import type {
  AgentDefinition,
  AgentSettings,
  OutputShape,
  ShellName,
  SimulationFile,
  StepType,
  TriggerKind,
} from '../schema/types';

export type StepStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped' | 'cancelled';
export type RunStatus = 'running' | 'success' | 'failure' | 'cancelled';
export type LogStream = 'stdout' | 'stderr' | 'agent' | 'tool' | 'info';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Per-step I/O handed to the host. `signal` aborts on cancel or step timeout. */
export interface StepIO {
  runId: string;
  stepId: string;
  signal: AbortSignal;
  log(stream: LogStream, text: string): void;
}

export interface ConsoleRequest {
  stepId: string;
  /** Command with templates already rendered. */
  command: string;
  shell: ShellName;
  /** Absolute or workspace-relative working directory (host resolves relative paths against the workspace root). */
  cwd: string;
  /** Extra environment variables (workflow env + step env, rendered). */
  env: Record<string, string>;
  /** Hard timeout; the host kills the process tree when it elapses. */
  timeoutMs?: number;
}

export interface ConsoleResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in arrival order. */
  output: string;
  timedOut: boolean;
}

/** Agent settings after merging the referenced agent file, inline settings and the step's model override. */
export interface ResolvedAgent extends AgentSettings {
  name: string;
  model: string;
}

export interface AgentRequest {
  stepId: string;
  /** Id of the referenced agent file, if any. */
  agentId?: string;
  agent: ResolvedAgent;
  /** Prompt with templates already rendered. */
  prompt: string;
  output?: { format: 'text' | 'json'; schema?: OutputShape };
  /** Previous conversation of this step when `session: continue`, otherwise empty. */
  history: ChatMessage[];
  /** Workspace-relative globs whose files should be attached as context. */
  contextFiles: string[];
}

export interface AgentResult {
  text: string;
  /** Parsed JSON when output.format is json. */
  json?: unknown;
  /** Model ref that actually answered (may be a fallback). */
  model: string;
  usage: Usage;
  turns: number;
  /** Tool calls the agent made (all models of the block); becomes `steps.<id>.toolCalls`. */
  toolCalls?: number;
  /** Full conversation after this call; stored by the engine for `session: continue`. */
  messages: ChatMessage[];
}

export interface ApprovalRequest {
  stepId: string;
  /** Message with templates rendered. */
  message: string;
}

export interface ApprovalResult {
  approved: boolean;
  comment?: string;
}

/** An ask block's question, with templates rendered. */
export interface AskRequest {
  stepId: string;
  question: string;
  /** Allowed answers (rendered); free text when omitted. */
  choices?: string[];
  /** Preselected answer (rendered). */
  default?: string;
  /**
   * The block's timeout, so the host can show the time left. The engine enforces it through `io.signal` and then
   * uses `default` (or fails the block when there is none); the host only has to stop asking when it aborts.
   */
  timeoutMs?: number;
}

export interface AskResult {
  /** With choices: one of them (anything else fails the block). */
  answer: string;
}

export interface EngineHost {
  runConsole(req: ConsoleRequest, io: StepIO): Promise<ConsoleResult>;
  runAgent(req: AgentRequest, io: StepIO): Promise<AgentResult>;
  requestApproval(req: ApprovalRequest, io: StepIO): Promise<ApprovalResult>;
  /**
   * Asks the user an ask block's question. Optional: without it the engine answers with the default, else the
   * first choice, and fails blocks that have neither.
   */
  askUser?(req: AskRequest, io: StepIO): Promise<AskResult>;
}

/* ---------- workflows on code: expression roots `editor` and `git` ---------- */

/**
 * `editor.*`: the text editor the run was started from, captured at run start. Without an editor every field is
 * empty (`''`, line 0).
 */
export interface EditorContext {
  /** Selected text (all non-empty selections, joined with a newline; capped at 100 KB). `''` without a selection. */
  selection: string;
  /** Workspace-relative path with forward slashes (absolute outside the workspace folder; `''` for untitled). */
  file: string;
  /** VS Code language id, e.g. "typescript". */
  language: string;
  /** 1-based line of the cursor of the primary selection; 0 without an editor. */
  line: number;
}

/**
 * `git.*`: the git state of the run's workspace folder, captured at run start. Outside a repository (or without
 * git) every field is empty.
 */
export interface GitContext {
  /** Current branch; `''` for a detached HEAD or outside a repository. */
  branch: string;
  /**
   * Changed, added, deleted, renamed (new path) and untracked files, relative to the workspace folder, forward
   * slashes, sorted, without duplicates; at most 1,000 paths.
   */
  changedFiles: string[];
  /**
   * Uncommitted changes as `git diff HEAD` (staged and unstaged; untracked files are not included), cut at 100 KB
   * at a line boundary with a final line that says how much was left out.
   */
  diff: string;
}

/** How a run was started; recorded at run start and shown in the history ("Started on save of src/app.ts"). */
export type RunOrigin =
  | { kind: 'manual' }
  /** Command "Run workflow on selection". */
  | { kind: 'selection' }
  /** A trigger of the workflow's `on:`; `file` (save and change) is workspace-relative. */
  | { kind: 'trigger'; trigger: TriggerKind; file?: string }
  /** Copilot: a language model tool call or the @isarflow chat participant. */
  | { kind: 'copilot' }
  /** The command line runner (`isar-flow run`). */
  | { kind: 'cli' };

/* ---------- test mode (simulation) ---------- */

export interface SimulationHostOptions {
  /** Mocks of the workflow's simulation file; blocks without mocks get the defaults. */
  file: SimulationFile;
  /** Pause per host call in ms, so the canvas can show the flow (default 0). */
  delayMs?: number;
}

/**
 * Engine host of a simulated run (createSimulationHost): no commands, no model calls, no file changes. Call n of
 * a block uses its mock n; the last mock repeats. Approvals are answered from the mocks or the file's `approvals`
 * default without asking anyone.
 */
export interface SimulationHost extends EngineHost {
  /** Host calls per block id so far (retries and loop iterations count). */
  calls(): Record<string, number>;
}

/* ---------- run from here (resume) ---------- */

/** The run a resumed run continues and the block it started at. */
export interface ResumedFrom {
  runId: string;
  stepId: string;
}

/** Run from here: where a new run continues a finished one. */
export interface ResumeOptions {
  /** The run this one continues (copied to run-start as `resumedFrom.runId`). */
  fromRunId: string;
  /**
   * Block to start at. Blocks before it in document order are not executed; containers that contain it are
   * entered without re-evaluating what led there; from the target on everything runs normally.
   */
  stepId: string;
  /**
   * Outputs of the source run by block id (its RunView step outputs; secrets are already masked there). Blocks
   * before the target that have one are reported with a `reused` step-end and seed `steps.<id>`.
   */
  outputs: Record<string, StepOutput>;
  /** Iteration to continue at for each loop that contains the target, by loop id (1-based; missing = 1). */
  loopIterations: Record<string, number>;
  /**
   * Block hashes of the source run (its RunView.blockHashes; missing for runs saved before they existed). A reused
   * output comes from the source run's YAML, so run-start records these hashes for the reused blocks.
   */
  blockHashes?: Record<string, string>;
}

/* ---------- live values ---------- */

/**
 * What expressions could read besides inputs and block outputs, captured at run start for live values. Holds
 * names only: env and secret values are never stored.
 */
export interface RunContextSnapshot {
  /** Names of `env.*`: the process environment plus the workflow's `env` keys, sorted, without duplicates. */
  env: string[];
  /** Names of `secrets.*`, sorted. */
  secrets: string[];
  workflow: { name: string; file: string };
  workspace: { root: string };
  /**
   * `editor.*` of the run for live values: `selection` cut at 2,048 characters, secrets masked. Only when the run
   * got RunOptions.editor; missing for runs saved before Package C.
   */
  editor?: EditorContext;
  /**
   * `git.*` of the run for live values: `diff` cut at 2,048 characters, `changedFiles` at 200 paths, secrets
   * masked. Only when the run got RunOptions.git.
   */
  git?: GitContext;
}

export interface RunOptions {
  runId: string;
  inputs: Record<string, unknown>;
  host: EngineHost;
  /** Agent files by id (workspace agents override user agents before they get here). */
  agents: Record<string, AgentDefinition>;
  signal?: AbortSignal;
  /** Process environment visible as `env.*` (workflow `env` is merged on top). */
  env?: Record<string, string>;
  /**
   * Readable as `secrets.*` in expressions. Values of 4 or more characters are replaced with '••••••' in
   * every event and in the run summary; the host still receives the real values.
   */
  secrets?: Record<string, string>;
  workflowFile?: string;
  workspaceRoot: string;
  /** Maximum input+output tokens across agent steps; 0/undefined = unlimited. */
  tokenBudget?: number;
  defaultShell?: ShellName;
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Run from here: continue a finished run at a block (see ResumeOptions); `inputs` are this run's inputs. */
  resume?: ResumeOptions;
  /**
   * Test mode: marks the run as simulated in its run-start event. The engine runs as usual; the caller passes a
   * simulation host, so nothing is executed.
   */
  simulated?: boolean;
  /**
   * `editor.*` captured by the host at run start; omitted = no editor (all fields empty). Hosts capture it only
   * for workflows that read `editor.*` (workflowUsesRoot).
   */
  editor?: EditorContext;
  /**
   * `git.*` captured by the host at run start; omitted = not captured (all fields empty). Hosts capture it only
   * for workflows that read `git.*`, and never in untrusted workspaces (git can run repository hooks).
   */
  git?: GitContext;
  /** How the run was started (copied to run-start); omitted = manual. */
  origin?: RunOrigin;
}

/**
 * Outputs of a block, readable as `steps.<id>.<key>`. Always contains `status`. `error` is set for failed and
 * cancelled blocks and holds the same text as the step-end event's `error`.
 */
export type StepOutput = Record<string, unknown> & {
  status: StepStatus;
  durationMs?: number;
  error?: string;
};

export type RunEvent =
  | {
      type: 'run-start';
      runId: string;
      workflowName: string;
      startedAt: number;
      inputs: Record<string, unknown>;
      /** Run from here: the run this one continues and the block it starts at. */
      resumedFrom?: ResumedFrom;
      /** Test mode (RunOptions.simulated). */
      simulated?: boolean;
      /** Names expressions can read besides inputs and block outputs (live values). */
      context?: RunContextSnapshot;
      /** Hash of each block's own YAML at run start, by block id, for "changed since that run" (Run from here). */
      blockHashes?: Record<string, string>;
      /** How the run was started (RunOptions.origin); omitted for manual runs. */
      origin?: RunOrigin;
    }
  | {
      type: 'step-start';
      runId: string;
      stepId: string;
      stepType: StepType;
      /** 1-based iteration of the innermost enclosing loop, if any. */
      iteration?: number;
      /** Rendered prompt / command / message for the inspector. */
      detail?: string;
      at: number;
    }
  | { type: 'step-log'; runId: string; stepId: string; stream: LogStream; text: string }
  | {
      type: 'step-end';
      runId: string;
      stepId: string;
      status: StepStatus;
      output: StepOutput;
      error?: string;
      durationMs: number;
      at: number;
      /**
       * Run from here: the block was not executed. `status` and `output` are copied from the run this one
       * continues; no step-start precedes it, `durationMs` is 0, and its usage does not count for this run.
       */
      reused?: boolean;
    }
  | { type: 'loop-iteration'; runId: string; stepId: string; iteration: number; maxIterations: number }
  | {
      type: 'run-end';
      runId: string;
      status: Exclude<RunStatus, 'running'>;
      error?: string;
      durationMs: number;
      usage: Usage;
    };

export interface RunSummary {
  runId: string;
  status: Exclude<RunStatus, 'running'>;
  error?: string;
  steps: Record<string, StepOutput>;
  usage: Usage;
  durationMs: number;
}
