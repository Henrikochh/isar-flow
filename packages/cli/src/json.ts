import type { RunOrigin, RunSummary, StepStatus, Usage } from '@isar-flow/core';

export interface JsonStep {
  status: StepStatus;
  durationMs?: number;
  error?: string;
  /** The block's outputs besides status, duration and error (`steps.<id>.*` in expressions). */
  output?: Record<string, unknown>;
}

/** The one JSON document `--json` prints on stdout. */
export interface JsonResult {
  runId: string;
  workflow: { name: string; file: string };
  status: RunSummary['status'];
  durationMs: number;
  error?: string;
  usage: Usage;
  simulated?: boolean;
  origin: RunOrigin;
  inputs: Record<string, unknown>;
  steps: Record<string, JsonStep>;
}

export interface JsonRunInfo {
  name: string;
  /** Workspace-relative path of the workflow file. */
  file: string;
  /** The run's inputs as the engine received them (run-start). */
  inputs: Record<string, unknown>;
  simulated: boolean;
}

/** Builds the result from the run summary (secrets are already masked there). */
export function jsonResult(summary: RunSummary, run: JsonRunInfo): JsonResult {
  const steps: Record<string, JsonStep> = {};
  for (const [id, { status, durationMs, error, ...rest }] of Object.entries(summary.steps)) {
    steps[id] = {
      status,
      ...(durationMs !== undefined && { durationMs }),
      ...(error !== undefined && { error }),
      ...(Object.keys(rest).length > 0 && { output: rest }),
    };
  }
  return {
    runId: summary.runId,
    workflow: { name: run.name, file: run.file },
    status: summary.status,
    durationMs: summary.durationMs,
    ...(summary.error !== undefined && { error: summary.error }),
    usage: summary.usage,
    ...(run.simulated && { simulated: true }),
    origin: { kind: 'cli' },
    inputs: run.inputs,
    steps,
  };
}

/** The JSON document when the run could not start (file not found, invalid workflow or config, inputs). */
export function jsonFailure(
  error: string,
  workflow?: { name: string; file: string },
  details: readonly string[] = [],
): Record<string, unknown> {
  return {
    status: 'failure',
    error,
    ...(workflow && { workflow }),
    ...(details.length > 0 && { details: [...details] }),
  };
}
