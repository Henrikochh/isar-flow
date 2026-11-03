import { resumeOptions, resumePreview, type ResumeOptions, type Workflow } from '@isar-flow/core';
import type { RunHistory, RunStartOptions } from '../contracts';

export const SOURCE_GONE_MESSAGE = 'That run is no longer in the history. Run the workflow instead.';

export type ResumePlan = { resume: ResumeOptions; inputs: Record<string, unknown> } | { error: string };

/**
 * Run from here: the engine options that continue a saved run of this workflow at a block, with that run's
 * inputs, or the message that says why it can't continue.
 */
export async function resumePlan(
  history: RunHistory,
  workflowUri: string,
  workflow: Workflow,
  request: NonNullable<RunStartOptions['resume']>,
): Promise<ResumePlan> {
  const saved = history.list(workflowUri).some((record) => record.runId === request.runId);
  const source = saved ? await history.getAsync(request.runId) : undefined;
  if (!source) return { error: SOURCE_GONE_MESSAGE };
  const { blocker } = resumePreview(workflow, source, request.stepId);
  if (blocker !== undefined) return { error: blocker };
  return { resume: resumeOptions(workflow, source, request.stepId), inputs: source.inputs };
}
