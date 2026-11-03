/** Review fixtures: files a run changed, for the review card scenarios, tests and screenshots. */
import type { ReviewCounts, ReviewDecision, ReviewFile, RunReview } from '@isar-flow/core';

/** A file whose revert always fails in the mock host, to show a failed decision. */
export const READ_ONLY_PATH = 'config/deploy.readonly.json';

const file = (path: string, rest: Partial<ReviewFile> = {}): ReviewFile => ({
  path,
  status: 'modified',
  stepIds: [],
  decision: 'pending',
  revertible: true,
  ...rest,
});

/** The five changes of a typical review-loop run: agent edits, a command's deletion, a binary and a lockfile. */
export const REVIEW_FILES: ReviewFile[] = [
  file('assets/logo.png', { binary: true }),
  file('docs/vouchers.md', { status: 'deleted', additions: 0, deletions: 27 }),
  file('package-lock.json', { additions: 1204, deletions: 388 }),
  file('src/cart.ts', { additions: 12, deletions: 3, stepIds: ['implement', 'fix'] }),
  file('src/checkout/vouchers.test.ts', { status: 'added', additions: 48, deletions: 0, stepIds: ['fix'] }),
];

const decide = (files: ReviewFile[], decisions: Record<string, ReviewDecision>): ReviewFile[] =>
  files.map((f) => (decisions[f.path] ? { ...f, decision: decisions[f.path] } : f));

export function reviewFixture(runId: string, files: ReviewFile[] = REVIEW_FILES): RunReview {
  return { runId, coverage: 'git', isolation: 'workspace', files };
}

/** No git: only what agents wrote is listed; one original was too large to keep, one revert failed. */
export function journalReview(runId: string): RunReview {
  return {
    runId,
    coverage: 'journal',
    isolation: 'workspace',
    overlapping: true,
    files: [
      file(READ_ONLY_PATH, { additions: 2, deletions: 2, stepIds: ['implement'] }),
      file('src/cart.ts', {
        additions: 12,
        deletions: 3,
        stepIds: ['implement', 'fix'],
        error: 'Could not write src/cart.ts: another program has it open. Close it and try again.',
      }),
      file('src/checkout/vouchers.test.ts', {
        status: 'added',
        additions: 48,
        deletions: 0,
        stepIds: ['fix'],
      }),
      file('test/fixtures/catalog-snapshot.json', {
        additions: 18_240,
        deletions: 17_902,
        stepIds: ['fix'],
        revertible: false,
      }),
    ],
  };
}

/** A worktree run halfway through its review. */
export function worktreeReview(runId: string): RunReview {
  return {
    runId,
    coverage: 'git',
    isolation: 'worktree',
    worktreeAvailable: true,
    files: decide(REVIEW_FILES, { 'src/cart.ts': 'kept', 'docs/vouchers.md': 'reverted' }),
  };
}

/** Every file decided: the card shows "3 kept, 1 reverted". */
export function doneReview(runId: string): RunReview {
  return reviewFixture(
    runId,
    decide(REVIEW_FILES.slice(1), {
      'docs/vouchers.md': 'reverted',
      'package-lock.json': 'kept',
      'src/cart.ts': 'kept',
      'src/checkout/vouchers.test.ts': 'kept',
    }),
  );
}

/** Two files left to review (the run before the newest one in the harness history). */
export function pendingReview(runId: string): RunReview {
  return reviewFixture(
    runId,
    decide(REVIEW_FILES.slice(1), { 'docs/vouchers.md': 'kept', 'package-lock.json': 'kept' }),
  );
}

/** Deeply nested paths and long file names, to check that the file name stays readable when space runs out. */
export const LONG_REVIEW_FILES: ReviewFile[] = [
  file(
    'packages/checkout-service/src/features/vouchers/application/commands/apply-voucher-to-cart.handler.ts',
    {
      additions: 86,
      deletions: 14,
      stepIds: ['implement'],
    },
  ),
  file(
    'packages/checkout-service/test/integration/vouchers/apply-voucher-to-cart-when-the-voucher-has-expired.integration.test.ts',
    { status: 'added', additions: 132, deletions: 0, stepIds: ['fix'] },
  ),
  ...REVIEW_FILES,
];

/** The cap of a review: 500 listed files and more that are not listed. */
export function manyFilesReview(runId: string): RunReview {
  const files = Array.from({ length: 500 }, (_, i) =>
    file(`src/generated/locales/messages-${String(i + 1).padStart(3, '0')}.json`, {
      additions: 3 + (i % 7),
      deletions: i % 3,
    }),
  );
  return { ...reviewFixture(runId, files), omitted: 37, omittedPending: 37 };
}

/** The review as the extension sends it: `omittedPending` follows the decision of the files that are not listed. */
export function withOmittedPending(review: RunReview, omittedDecision: ReviewDecision): RunReview {
  const { omittedPending: _old, ...rest } = review;
  const omitted = review.omitted ?? 0;
  return omittedDecision === 'pending' && omitted > 0 ? { ...rest, omittedPending: omitted } : rest;
}

/** History counts for a review; the files that are not listed share `omittedDecision`. */
export function countsOf(review: RunReview, omittedDecision: ReviewDecision = 'pending'): ReviewCounts {
  const omitted = review.omitted ?? 0;
  const count = (decision: ReviewDecision) =>
    review.files.filter((f) => f.decision === decision).length + (omittedDecision === decision ? omitted : 0);
  return {
    total: review.files.length + omitted,
    kept: count('kept'),
    reverted: count('reverted'),
    pending: count('pending'),
  };
}
