import { findStep, type ResumePreview, type Workflow } from '@isar-flow/core';

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A block's name, else its id. */
export function blockLabel(workflow: Workflow, id: string): string {
  const name: unknown = findStep(Array.isArray(workflow.steps) ? workflow.steps : [], id)?.step.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : id;
}

/**
 * What to check before a run continues at a block (Run from here without the canvas dialog): reused results that
 * may be outdated, missing or shortened, masked secrets, loops past their limit, forced branches, new
 * conversations and worktree runs. Same wording as the canvas dialog.
 */
export function resumeWarnings(preview: ResumePreview, workflow: Workflow): string[] {
  const names = (ids: string[]) => joinNames(ids.map((id) => blockLabel(workflow, id)));
  const target = blockLabel(workflow, preview.stepId);
  const one = (ids: string[], single: string, several: string) =>
    ids.length === 0 ? [] : [`${names(ids)} ${ids.length === 1 ? single : several}`];
  return [
    ...one(
      preview.changed,
      'changed since that run, so its result may be outdated.',
      'changed since that run, so their results may be outdated.',
    ),
    ...one(
      preview.missing,
      'has no result in that run; expressions that read it get empty values.',
      'have no result in that run; expressions that read them get empty values.',
    ),
    ...(preview.changesUnknown
      ? ["That run was saved by an older version, so changes since then can't be checked."]
      : []),
    ...(preview.trimmed.length === 1
      ? [`${names(preview.trimmed)}'s saved result was shortened to fit the history.`]
      : preview.trimmed.length > 1
        ? [`The saved results of ${names(preview.trimmed)} were shortened to fit the history.`]
        : []),
    ...(preview.masked.length === 1
      ? [`${names(preview.masked)}'s result contains a secret; blocks after it get •••••• instead.`]
      : preview.masked.length > 1
        ? [`The results of ${names(preview.masked)} contain a secret; blocks after them get •••••• instead.`]
        : []),
    ...preview.loops
      .filter((loop) => loop.iteration > loop.maxIterations)
      .map(
        (loop) =>
          `${blockLabel(workflow, loop.stepId)} was at iteration ${loop.iteration}; its limit is now ${loop.maxIterations}, so it ends after this iteration.`,
      ),
    ...preview.forcedBranches.map(
      (forced) =>
        `${blockLabel(workflow, forced.stepId)} took the other branch in that run; this run takes the branch with ${target}.`,
    ),
    ...one(preview.freshSessions, 'starts a new conversation.', 'start a new conversation.'),
    ...(workflow.isolation === 'worktree'
      ? [
          'This workflow runs in a separate worktree, so files start from your workspace, not from where that run stopped.',
        ]
      : []),
  ];
}
