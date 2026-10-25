import type { LogStream, RunStatus, StepOutput, StepStatus, Usage } from '../engine/types';

export interface LogLine {
  stream: LogStream;
  text: string;
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
