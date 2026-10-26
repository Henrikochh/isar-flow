import type { ChatMessage } from '../models/types';
import type { AgentDefinition, AgentSettings, OutputShape, ShellName, StepType } from '../schema/types';

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

export interface EngineHost {
  runConsole(req: ConsoleRequest, io: StepIO): Promise<ConsoleResult>;
  runAgent(req: AgentRequest, io: StepIO): Promise<AgentResult>;
  requestApproval(req: ApprovalRequest, io: StepIO): Promise<ApprovalResult>;
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
  | { type: 'run-start'; runId: string; workflowName: string; startedAt: number; inputs: Record<string, unknown> }
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
    }
  | { type: 'loop-iteration'; runId: string; stepId: string; iteration: number; maxIterations: number }
  | { type: 'run-end'; runId: string; status: Exclude<RunStatus, 'running'>; error?: string; durationMs: number; usage: Usage };

export interface RunSummary {
  runId: string;
  status: Exclude<RunStatus, 'running'>;
  error?: string;
  steps: Record<string, StepOutput>;
  usage: Usage;
  durationMs: number;
}
