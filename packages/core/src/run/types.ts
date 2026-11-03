import type { LogStream, RunStatus, StepOutput, StepStatus, Usage } from '../engine/types';

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
}
