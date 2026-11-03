import { describe, expect, it } from 'vitest';
import type { RunReview } from '@isar-flow/core';
import {
  doneReview as doneReviewOf,
  journalReview,
  manyFilesReview,
  reviewFixture,
  worktreeReview,
  REVIEW_FILES,
} from '../../../harness/reviews';
import {
  decidedSummary,
  filesChangedTitle,
  keepBlocker,
  pendingLabel,
  revertAllBlocker,
  revertAllQuestion,
  revertBlocker,
  reviewCounts,
  reviewNotes,
  splitPath,
} from '../../../src/views/workflow/review/model';

describe('review model', () => {
  it('titles the card by the number of changed files, listed or not', () => {
    expect(filesChangedTitle(1)).toBe('1 file changed');
    expect(filesChangedTitle(3)).toBe('3 files changed');
    expect(reviewCounts(manyFilesReview('r')).total).toBe(537);
  });

  it('counts decisions of the listed files', () => {
    expect(reviewCounts(worktreeReview('r'))).toEqual({ total: 5, kept: 1, reverted: 1, pending: 3 });
  });

  it('counts files that are not listed and still wait as pending', () => {
    const decided: RunReview = { ...doneReviewOf('r'), omitted: 5, omittedPending: 2 };
    expect(reviewCounts(decided)).toEqual({ total: 9, kept: 3, reverted: 1, pending: 2 });
  });

  it('summarizes decided files without zero parts', () => {
    expect(decidedSummary({ total: 4, kept: 3, reverted: 1, pending: 0 })).toBe('3 kept, 1 reverted');
    expect(decidedSummary({ total: 2, kept: 2, reverted: 0, pending: 0 })).toBe('2 kept');
    expect(decidedSummary({ total: 1, kept: 0, reverted: 1, pending: 0 })).toBe('1 reverted');
    expect(decidedSummary({ total: 0, kept: 0, reverted: 0, pending: 0 })).toBeNull();
    expect(pendingLabel(2)).toBe('2 to review');
  });

  it('splits a path into its folder and file name', () => {
    expect(splitPath('src/checkout/vouchers.test.ts')).toEqual({
      folder: 'src/checkout/',
      name: 'vouchers.test.ts',
    });
    expect(splitPath('package-lock.json')).toEqual({ folder: '', name: 'package-lock.json' });
  });

  it('explains journal coverage, worktrees, overlapping runs and files that are not listed', () => {
    expect(reviewNotes(reviewFixture('r'))).toEqual([]);
    expect(reviewNotes(journalReview('r')).map((n) => n.text)).toEqual([
      "This folder isn't a git repository, so only files that agents wrote are listed. Changes made by console commands can't be reviewed or reverted.",
      'Another run changed this folder at the same time, so this list may include its changes.',
    ]);
    expect(reviewNotes(worktreeReview('r')).map((n) => n.text)).toEqual([
      'This run worked in a separate git worktree. Keep copies a change into your workspace; Revert drops it.',
    ]);
    expect(reviewNotes(manyFilesReview('r')).map((n) => n.text)).toEqual([
      '37 more files are not listed. Keep all and Revert all include them.',
    ]);
    expect(reviewNotes({ ...reviewFixture('r'), omitted: 1 })[0].text).toBe(
      '1 more file is not listed. Keep all and Revert all include it.',
    );
  });

  it('says why a file cannot be kept or reverted', () => {
    const review = reviewFixture('r');
    const [binary] = REVIEW_FILES;
    expect(revertBlocker(review, binary)).toBeUndefined();
    expect(revertBlocker(review, { ...binary, revertible: false })).toBe(
      "The state before the run wasn't saved, so this file can't be reverted.",
    );
    expect(keepBlocker(review)).toBeUndefined();
    const removed: RunReview = { ...worktreeReview('r'), worktreeAvailable: false };
    expect(keepBlocker(removed)).toBe(
      "The run's worktree was removed, so its changes can't be copied into your workspace.",
    );
  });

  it('allows Revert all while a pending file can be reverted or files are not listed', () => {
    const allLocked: RunReview = {
      ...reviewFixture('r'),
      files: REVIEW_FILES.map((f) => ({ ...f, revertible: false })),
    };
    expect(revertAllBlocker(reviewFixture('r'))).toBeUndefined();
    expect(revertAllBlocker(allLocked)).toBe(
      "None of the files can be reverted: their state before the run wasn't saved.",
    );
    expect(revertAllBlocker({ ...allLocked, omitted: 3, omittedPending: 3 })).toBeUndefined();
    // Files that are not listed but already decided give Revert all nothing to do.
    expect(revertAllBlocker({ ...allLocked, omitted: 3 })).toBe(
      "None of the files can be reverted: their state before the run wasn't saved.",
    );
  });

  it('asks before Revert all with the number of files it reverts and what happens to them', () => {
    expect(revertAllQuestion(reviewFixture('r'))).toEqual({
      title: 'Revert 5 files?',
      detail: 'Changed files go back to how they were before the run, and files the run added are deleted.',
      confirm: 'Revert 5 files',
    });
    // Files that are not listed count; decided files and files without a saved state do not.
    expect(revertAllQuestion(journalReview('r'))).toEqual({
      title: 'Revert 3 files?',
      detail:
        "Changed files go back to how they were before the run, and files the run added are deleted. 1 file can't be reverted and stays as it is.",
      confirm: 'Revert 3 files',
    });
    expect(revertAllQuestion(manyFilesReview('r')).title).toBe('Revert 537 files?');
    const one = reviewFixture('r', REVIEW_FILES.slice(0, 1));
    expect(revertAllQuestion(one)).toMatchObject({ title: 'Revert 1 file?', confirm: 'Revert 1 file' });
  });

  it('says that reverting a worktree run leaves the workspace alone', () => {
    expect(revertAllQuestion(worktreeReview('r'))).toEqual({
      title: 'Revert 3 files?',
      detail: "The run's changes to them are dropped. Your workspace stays as it is.",
      confirm: 'Revert 3 files',
    });
  });
});
