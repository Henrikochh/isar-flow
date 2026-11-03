import { blockHashes } from '../run/blockHash';
import type { Workflow } from '../schema/types';
import { resumePath, splitAtTarget, storedOutput } from './resume';
import type { ResumeOptions, RunContextSnapshot, RunEvent, RunOptions } from './types';

const keysOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : [];

/** What expressions can read besides inputs and block outputs; names only, never env or secret values. */
export function runContextSnapshot(workflow: Workflow, options: RunOptions): RunContextSnapshot {
  return {
    env: [...new Set([...keysOf(options.env), ...keysOf(workflow.env)])].sort(),
    secrets: keysOf(options.secrets).sort(),
    workflow: { name: workflow.name, file: options.workflowFile ?? '' },
    workspace: { root: options.workspaceRoot },
  };
}

/**
 * Hash of each block's YAML at run start. A block a resumed run reuses keeps the source run's hash (none when that
 * run has none), because its output was made by that YAML: a later Run from here still sees that it changed.
 */
function recordedHashes(workflow: Workflow, resume: ResumeOptions | undefined): Record<string, string> {
  const hashes = new Map(Object.entries(blockHashes(workflow)));
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const path = resume && resumePath(steps, resume.stepId);
  if (!resume || !path) return Object.fromEntries(hashes);
  const source = resume.blockHashes;
  for (const [id, step] of splitAtTarget(steps, path).before) {
    if (!storedOutput(resume, step)) continue;
    if (source && Object.hasOwn(source, id)) hashes.set(id, source[id]);
    else hashes.delete(id);
  }
  return Object.fromEntries(hashes);
}

export function runStartEvent(
  workflow: Workflow,
  options: RunOptions,
  startedAt: number,
  inputs: Record<string, unknown>,
): Extract<RunEvent, { type: 'run-start' }> {
  const { resume, simulated } = options;
  return {
    type: 'run-start',
    runId: options.runId,
    workflowName: workflow.name,
    startedAt,
    inputs,
    ...(resume && { resumedFrom: { runId: resume.fromRunId, stepId: resume.stepId } }),
    ...(simulated === true && { simulated: true }),
    context: runContextSnapshot(workflow, options),
    blockHashes: recordedHashes(workflow, resume),
  };
}
