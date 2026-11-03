/** "Run from here": when it is possible, and what the dialog tells the user before the run starts. */
import type { ResumePreview, RunRecordSummary, RunView, Workflow } from '@isar-flow/core';
import { formatRelativeTime } from '../../../hooks';

export type RunFromHereState = { ok: true } | { ok: false; reason: string };

/** Whether the shown run can be continued at a block of the current document. */
export function runFromHereState(
  run: RunView | null,
  trusted: boolean,
  docValid: boolean,
  _stepId?: string,
): RunFromHereState {
  if (!run) return { ok: false, reason: 'Show a finished run to run from here.' };
  if (run.status === 'running') return { ok: false, reason: 'Wait until the run has finished.' };
  if (run.simulated)
    return { ok: false, reason: "Simulated runs can't be continued. Run the workflow first." };
  const blocker = startBlocker(trusted, docValid);
  return blocker ? { ok: false, reason: blocker } : { ok: true };
}

/** Why no run can start from this document right now (trust and problems only). */
export function startBlocker(trusted: boolean, docValid: boolean): string | undefined {
  if (!trusted) return 'Running is disabled until you trust this workspace.';
  if (!docValid) return 'Fix the problems before running.';
  return undefined;
}

const SLOTS = ['steps', 'then', 'else'] as const;

/** The block's name, else its id; tolerates lenient workflows (odd values, unknown keys). */
export function blockName(workflow: Workflow | null | undefined, id: string): string {
  let found: string | undefined;
  const visit = (list: unknown) => {
    if (found !== undefined || !Array.isArray(list)) return;
    for (const item of list as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const block = item as Record<string, unknown>;
      if (block.id === id) {
        found = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : id;
        return;
      }
      for (const slot of SLOTS) visit(block[slot]);
    }
  };
  visit(workflow?.steps);
  return found ?? id;
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface ResumeNotes {
  /** Quiet lines: what is reused and where loops continue. */
  info: string[];
  /** Things to check before running, shown in a warning banner. */
  warnings: string[];
}

export function resumeNotes(
  preview: ResumePreview,
  workflow: Workflow | null,
  run: RunView,
  record?: RunRecordSummary,
  now = Date.now(),
): ResumeNotes {
  const name = (id: string) => blockName(workflow, id);
  const names = (ids: string[]) => joinNames(ids.map(name));
  const target = name(preview.stepId);
  const info: string[] = [];
  const warnings: string[] = [];

  if (preview.reused.length)
    info.push(
      `Blocks before ${target} reuse the results of the run from ${formatRelativeTime(run.startedAt, now)}.`,
    );
  for (const loop of preview.loops) {
    if (loop.iteration <= loop.maxIterations)
      info.push(`${name(loop.stepId)} continues at iteration ${loop.iteration} of ${loop.maxIterations}.`);
  }

  const { changed, missing, trimmed, masked, freshSessions } = preview;
  if (changed.length === 1)
    warnings.push(`${names(changed)} changed since that run, so its result may be outdated.`);
  else if (changed.length)
    warnings.push(`${names(changed)} changed since that run, so their results may be outdated.`);
  if (missing.length === 1)
    warnings.push(`${names(missing)} has no result in that run; expressions that read it get empty values.`);
  else if (missing.length)
    warnings.push(
      `${names(missing)} have no result in that run; expressions that read them get empty values.`,
    );
  if (preview.changesUnknown)
    warnings.push("That run was saved by an older version, so changes since then can't be checked.");
  if (trimmed.length === 1)
    warnings.push(`${names(trimmed)}'s saved result was shortened to fit the history.`);
  else if (trimmed.length)
    warnings.push(`The saved results of ${names(trimmed)} were shortened to fit the history.`);
  if (masked.length === 1)
    warnings.push(`${names(masked)}'s result contains a secret; blocks after it get •••••• instead.`);
  else if (masked.length)
    warnings.push(`The results of ${names(masked)} contain a secret; blocks after them get •••••• instead.`);
  for (const loop of preview.loops) {
    if (loop.iteration > loop.maxIterations)
      warnings.push(
        `${name(loop.stepId)} was at iteration ${loop.iteration}; its limit is now ${loop.maxIterations}, so it ends after this iteration.`,
      );
  }
  for (const forced of preview.forcedBranches)
    warnings.push(
      `${name(forced.stepId)} took the other branch in that run; this run takes the branch with ${target}.`,
    );
  if (freshSessions.length === 1) warnings.push(`${names(freshSessions)} starts a new conversation.`);
  else if (freshSessions.length) warnings.push(`${names(freshSessions)} start a new conversation.`);
  if ((workflow as { isolation?: unknown } | null)?.isolation === 'worktree')
    warnings.push(
      'This workflow runs in a separate worktree, so files start from your workspace, not from where that run stopped.',
    );
  const reverted = record?.review?.reverted ?? 0;
  if (reverted > 0)
    warnings.push(
      `You reverted ${reverted} ${reverted === 1 ? 'file' : 'files'} of that run; the blocks from ${target} on see the files as they are now.`,
    );
  return { info, warnings };
}

/** "the run from 5 min ago" for the run a resumed run continues, or undefined when that run is not in the history. */
export function sourceRunLabel(
  run: RunView,
  history: readonly RunRecordSummary[],
  now = Date.now(),
): string | undefined {
  const sourceId = run.resumedFrom?.runId;
  const source = sourceId ? history.find((record) => record.runId === sourceId) : undefined;
  return source ? `the run from ${formatRelativeTime(source.startedAt, now)}` : undefined;
}
