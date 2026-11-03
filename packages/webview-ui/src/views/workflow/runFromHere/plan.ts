/** What happens when the user asks to run from a block of the shown run: start at once, or ask first. */
import {
  resumePreview,
  type RunRecordSummary,
  type RunView,
  type Workflow,
  type WorkflowInput,
} from '@isar-flow/core';
import { declaredInputs } from '../topbar/InputsDialog';
import { type ResumeNotes, resumeNotes, runFromHereState } from './model';

export type ResumePlan =
  /** Nothing to ask and nothing to check: post runFromHere with the inputs of that run (notes: only info). */
  | { kind: 'start'; notes: ResumeNotes }
  /** The dialog: inputs to confirm, notes to read, or why the run can't continue there. */
  | { kind: 'ask'; inputs: [string, WorkflowInput][]; notes: ResumeNotes; blocker?: string };

const NO_NOTES: ResumeNotes = { info: [], warnings: [] };

export function planResume({
  workflow,
  run,
  stepId,
  trusted,
  valid,
  record,
  now,
}: {
  workflow: Workflow | null;
  run: RunView;
  stepId: string;
  trusted: boolean;
  valid: boolean;
  /** The run's history entry (its review counts). */
  record?: RunRecordSummary;
  now?: number;
}): ResumePlan {
  const state = runFromHereState(run, trusted, valid && workflow !== null, stepId);
  if (!state.ok) return { kind: 'ask', inputs: [], notes: NO_NOTES, blocker: state.reason };
  // runFromHereState refuses an unreadable document, so the workflow is known here.
  const current = workflow as Workflow;
  const preview = resumePreview(current, run, stepId);
  if (preview.blocker) return { kind: 'ask', inputs: [], notes: NO_NOTES, blocker: preview.blocker };
  const inputs = declaredInputs(current.inputs);
  const notes = resumeNotes(preview, current, run, record, now);
  return inputs.length || notes.warnings.length ? { kind: 'ask', inputs, notes } : { kind: 'start', notes };
}
