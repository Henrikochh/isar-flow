import type {
  LogStream,
  ResumedFrom,
  RunContextSnapshot,
  RunStatus,
  StepOutput,
  StepStatus,
  Usage,
} from '../engine/types';

export interface LogLine {
  stream: LogStream;
  text: string;
}

/**
 * Time and tokens of one block over all its executions in a run (loops run their blocks several times).
 * Summed when a step-end arrives; skipped blocks get none.
 */
export interface StepMetrics {
  /** Sum of the durations of all finished executions. */
  durationMs: number;
  /** Finished executions counted so far. */
  executions: number;
  /** Agent blocks: tokens of all executions (failed attempts that used tokens included). */
  usage?: Usage;
  /** Agent blocks: model that answered the latest execution (may be a fallback model). */
  model?: string;
  /** Agent blocks: model round-trips of all executions. */
  turns?: number;
  /** Agent blocks: tool calls of all executions. */
  toolCalls?: number;
  /** Loop blocks: iterations of the latest execution. */
  iterations?: number;
}

/** Compact numbers of one block in a finished run, kept in the history index (RunRecordSummary.blocks) for trends. */
export interface BlockRunMetrics {
  status: StepStatus;
  /** Sum over all executions (StepMetrics.durationMs). */
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Loop blocks: iterations; other blocks: executions, only when more than one. */
  iterations?: number;
  /** Agent blocks: model of the latest execution, for cost estimates. */
  model?: string;
}

/** Live/recorded state of one block during a run, derived from RunEvents. */
export interface StepRunView {
  status: StepStatus;
  /** How often the block has started in this run (loops re-run blocks). */
  executions: number;
  /** Innermost loop iteration of the latest execution. */
  iteration?: number;
  /** For loop blocks: current iteration and limit. */
  loop?: { iteration: number; maxIterations: number };
  /** Rendered prompt / command / message of the latest execution. */
  detail?: string;
  output?: StepOutput;
  error?: string;
  durationMs?: number;
  startedAt?: number;
  /** Logs of the latest execution, capped (oldest dropped) to keep views small. */
  logs: LogLine[];
  /** True when logs were dropped because of the cap. */
  logsTruncated?: boolean;
  /** Totals over all executions of the block in this run; set from the first step-end on. */
  metrics?: StepMetrics;
  /**
   * Run from here: the block did not run; its status and output were copied from the run this one continues
   * (a reused step-end). Cleared when the block starts in this run (e.g. the next loop iteration).
   */
  reused?: boolean;
  /** Set by the history when it cut strings in `output` to fit the run into storage. */
  outputTrimmed?: boolean;
}

/** Snapshot of a run for the canvas, inspector and history. */
export interface RunView {
  runId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: number;
  durationMs?: number;
  error?: string;
  inputs: Record<string, unknown>;
  usage: Usage;
  /** Id of the block that most recently started and is still running. */
  activeStepId?: string;
  steps: Record<string, StepRunView>;
  /** Run from here: the run this one continued and the block it started at (from run-start). */
  resumedFrom?: ResumedFrom;
  /** Test mode: nothing was executed; results came from the simulation file (from run-start). */
  simulated?: boolean;
  /**
   * Names of env.* and secrets.*, workflow file and workspace root for live values (from run-start). Together with
   * `inputs`, the block outputs in `steps` and the loop iterations it is the run's expression context.
   */
  context?: RunContextSnapshot;
  /** Hash of each block's own YAML when the run started, by block id (from run-start); missing in older runs. */
  blockHashes?: Record<string, string>;
}

/* ---------- run from here ---------- */

/** A loop that contains the block a run resumes at, and the iteration it continues at. */
export interface ResumeLoopPoint {
  stepId: string;
  /** Iteration from the source run (the loop's latest one); 1 when the loop did not run there. */
  iteration: number;
  /** The loop's current limit. The resumed iteration runs even when it is past the limit; then the loop ends. */
  maxIterations: number;
}

/** What "Run from here" will do, shown before the run starts (resumePreview in core). */
export interface ResumePreview {
  /** Source run. */
  runId: string;
  /** Block the new run starts at. */
  stepId: string;
  /**
   * Why the run can't resume at this block (not in the workflow anymore, the source run is still running or was
   * simulated). When set, nothing else applies.
   */
  blocker?: string;
  /** Blocks before the target whose outputs are reused, in document order. */
  reused: string[];
  /** Reused blocks whose YAML changed since that run (hash differs or missing): their outputs may be outdated. */
  changed: string[];
  /** Blocks before the target without an output in that run (added or renamed since, or not reached). */
  missing: string[];
  /** Reused blocks whose saved output was cut to fit the history (StepRunView.outputTrimmed). */
  trimmed: string[];
  /** Reused blocks whose saved output contains a masked secret (••••••); blocks after see the mask. */
  masked: string[];
  /** The source run has no block hashes (saved by an older version), so changes can't be detected. */
  changesUnknown: boolean;
  /** Loops that contain the target, outermost first. */
  loops: ResumeLoopPoint[];
  /** Ifs that contain the target and took the other branch in that run; this run takes the target's branch. */
  forcedBranches: { stepId: string; branch: 'then' | 'else' }[];
  /** Agents with `session: continue` at or after the target that ran before: they start a new conversation. */
  freshSessions: string[];
}

/* ---------- live values ---------- */

/**
 * The expression context of one run as live values read it: inputs and the latest output of each block (strings
 * cut at 2,048 characters; secrets were already masked by the engine), the latest iteration of each loop, and the
 * names, never the values, of env.* and secrets.*. Built by liveContext(run) in core.
 */
export interface LiveContext {
  runId: string;
  startedAt: number;
  status: RunStatus;
  simulated?: boolean;
  inputs: Record<string, unknown>;
  /** Latest output of each block that has one (reused and skipped blocks included). */
  steps: Record<string, StepOutput>;
  /** Latest iteration of each loop that ran, by loop id; `loop.*` in templates inside it read these. */
  loops: Record<string, { iteration: number; index: number }>;
  /** Names of env.*; empty for runs saved before live values existed. */
  env: string[];
  /** Names of secrets.*; they evaluate to the mask. */
  secrets: string[];
  workflow: { name: string; file: string };
  workspace: { root: string };
}

export type LiveValueType = 'text' | 'number' | 'boolean' | 'list' | 'object' | 'empty';

/** Value of one `${{ … }}` expression in a run (liveValue in core). */
export type LiveValue =
  | {
      kind: 'value';
      /** As a template inserts it (objects and lists as pretty JSON), at most 2,048 characters. */
      text: string;
      type: LiveValueType;
      /** The value is longer than shown (cut at 2,048 characters, or built from an output that was cut). */
      truncated: boolean;
      /** The value contains a masked secret (••••••). */
      masked: boolean;
    }
  /** Nothing to show, e.g. "tests didn't run in this run." or "Environment values aren't saved with runs." */
  | { kind: 'unavailable'; message: string }
  /** The expression can't be evaluated, e.g. a syntax error; `message` is the evaluator's error. */
  | { kind: 'error'; message: string };
