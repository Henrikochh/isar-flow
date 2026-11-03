/** Pure helpers of the review card and the run history: counts, labels, notes and why an action is blocked. */
import type { ReviewCounts, ReviewFile, ReviewFileStatus, RunReview } from '@isar-flow/core';

export const STATUS_INFO: Record<ReviewFileStatus, { icon: string; label: string }> = {
  added: { icon: 'diff-added', label: 'Added' },
  modified: { icon: 'diff-modified', label: 'Modified' },
  deleted: { icon: 'diff-removed', label: 'Deleted' },
};

const files = (count: number) => (count === 1 ? '1 file' : `${count} files`);

export function filesChangedTitle(count: number): string {
  return `${files(count)} changed`;
}

/**
 * Decisions of the listed files; `total` also counts the files that are not listed, and `pending` those of them
 * that still wait.
 */
export function reviewCounts(review: RunReview): ReviewCounts {
  const count = (decision: ReviewFile['decision']) =>
    review.files.filter((f) => f.decision === decision).length;
  return {
    total: review.files.length + (review.omitted ?? 0),
    kept: count('kept'),
    reverted: count('reverted'),
    pending: count('pending') + (review.omittedPending ?? 0),
  };
}

export function pendingLabel(pending: number): string {
  return `${pending} to review`;
}

/** "3 kept, 1 reverted", or null when nothing was decided. */
export function decidedSummary(counts: ReviewCounts): string | null {
  const parts = [
    counts.kept > 0 ? `${counts.kept} kept` : null,
    counts.reverted > 0 ? `${counts.reverted} reverted` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(', ') : null;
}

/** Folder (with its trailing slash) and file name, so the name can stay visible when the folder is cut. */
export function splitPath(path: string): { folder: string; name: string } {
  const cut = path.lastIndexOf('/') + 1;
  return { folder: path.slice(0, cut), name: path.slice(cut) };
}

export interface ReviewNote {
  key: string;
  icon: string;
  text: string;
}

export function reviewNotes(review: RunReview): ReviewNote[] {
  const notes: ReviewNote[] = [];
  if (review.coverage === 'journal')
    notes.push({
      key: 'journal',
      icon: 'info',
      text: "This folder isn't a git repository, so only files that agents wrote are listed. Changes made by console commands can't be reviewed or reverted.",
    });
  if (review.isolation === 'worktree')
    notes.push({
      key: 'worktree',
      icon: 'git-branch',
      text: 'This run worked in a separate git worktree. Keep copies a change into your workspace; Revert drops it.',
    });
  if (review.overlapping)
    notes.push({
      key: 'overlapping',
      icon: 'warning',
      text: 'Another run changed this folder at the same time, so this list may include its changes.',
    });
  const omitted = review.omitted ?? 0;
  if (omitted > 0)
    notes.push({
      key: 'omitted',
      icon: 'list-flat',
      text:
        omitted === 1
          ? '1 more file is not listed. Keep all and Revert all include it.'
          : `${omitted} more files are not listed. Keep all and Revert all include them.`,
    });
  return notes;
}

/** Why Keep is unavailable for the review's files, or undefined when it works. */
export function keepBlocker(review: RunReview): string | undefined {
  return review.isolation === 'worktree' && review.worktreeAvailable === false
    ? "The run's worktree was removed, so its changes can't be copied into your workspace."
    : undefined;
}

export function revertBlocker(_review: RunReview, file: ReviewFile): string | undefined {
  return file.revertible
    ? undefined
    : "The state before the run wasn't saved, so this file can't be reverted.";
}

/** What Revert all asks before it reverts every pending file, the unlisted ones included. */
export function revertAllQuestion(review: RunReview): { title: string; detail: string; confirm: string } {
  const pending = review.files.filter((f) => f.decision === 'pending');
  const revertible = pending.filter((f) => f.revertible).length;
  const locked = pending.length - revertible;
  const count = files(revertible + (review.omittedPending ?? 0));
  const what =
    review.isolation === 'worktree'
      ? "The run's changes to them are dropped. Your workspace stays as it is."
      : 'Changed files go back to how they were before the run, and files the run added are deleted.';
  const kept =
    locked === 0
      ? ''
      : locked === 1
        ? " 1 file can't be reverted and stays as it is."
        : ` ${locked} files can't be reverted and stay as they are.`;
  return { title: `Revert ${count}?`, detail: what + kept, confirm: `Revert ${count}` };
}

export function revertAllBlocker(review: RunReview): string | undefined {
  const some =
    review.files.some((f) => f.decision === 'pending' && f.revertible) || (review.omittedPending ?? 0) > 0;
  return some ? undefined : "None of the files can be reverted: their state before the run wasn't saved.";
}
