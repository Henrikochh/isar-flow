import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { reduceRunEvent, type RunReview } from '@isar-flow/core';
import { AGENTS, CATALOG } from '../../../harness/fixtures';
import {
  doneReview,
  journalReview,
  manyFilesReview,
  reviewFixture,
  worktreeReview,
} from '../../../harness/reviews';
import { EditorProvider } from '../../../src/views/workflow/editorContext';
import { ReviewCard } from '../../../src/views/workflow/review/ReviewCard';
import {
  initialWorkflowUiState,
  useWorkflowState,
  WorkflowStoreProvider,
} from '../../../src/views/workflow/store';
import { clearPosted, docFor, host, posted, REVIEW_TEXT } from '../canvas/helpers';

const RUN_ID = 'run-8';

function Selection() {
  return <output aria-label="Selection">{useWorkflowState().selection ?? ''}</output>;
}

function renderCard(review: RunReview | null = reviewFixture(RUN_ID)) {
  clearPosted();
  const run = reduceRunEvent(null, {
    type: 'run-start',
    runId: RUN_ID,
    workflowName: 'Review until approved',
    startedAt: 0,
    inputs: {},
  });
  return render(
    <WorkflowStoreProvider
      initialState={{
        ...initialWorkflowUiState,
        doc: docFor(REVIEW_TEXT),
        agents: AGENTS,
        catalog: CATALOG,
        run,
        review,
      }}
    >
      <EditorProvider>
        <ReviewCard />
        <Selection />
      </EditorProvider>
    </WorkflowStoreProvider>,
  );
}

const card = () => screen.getByRole('region', { name: 'Review changes' });
const rows = () => within(screen.getByRole('list', { name: 'Changed files' })).getAllByRole('listitem');
const row = (path: string) => {
  const found = rows().find((r) => r.getAttribute('data-path') === path);
  if (!found) throw new Error(`no row for ${path}`);
  return found;
};

beforeEach(clearPosted);

describe('review card', () => {
  it('shows nothing without a review', () => {
    renderCard(null);
    expect(screen.queryByRole('region', { name: 'Review changes' })).not.toBeInTheDocument();
  });

  it('lists every changed file with its status, counts and the blocks that changed it', () => {
    renderCard();
    expect(within(card()).getByRole('heading', { name: '5 files changed' })).toBeInTheDocument();
    expect(within(card()).getByText('5 to review')).toBeInTheDocument();
    expect(rows()).toHaveLength(5);

    const cart = row('src/cart.ts');
    expect(within(cart).getByText('Modified')).toHaveClass('if-visually-hidden');
    expect(within(cart).getByText('src/')).toBeInTheDocument();
    expect(within(cart).getByText('cart.ts')).toBeInTheDocument();
    expect(within(cart).getByText('+12')).toBeInTheDocument();
    expect(within(cart).getByText('−3')).toBeInTheDocument();
    expect(within(cart).getByRole('button', { name: 'Select block implement' })).toBeInTheDocument();
    expect(within(cart).getByRole('button', { name: 'Select block fix' })).toBeInTheDocument();

    expect(within(row('src/checkout/vouchers.test.ts')).getByText('Added')).toBeInTheDocument();
    const deleted = row('docs/vouchers.md');
    expect(within(deleted).getByText('Deleted')).toBeInTheDocument();
    expect(within(deleted).getByText('Command')).toBeInTheDocument();
    expect(within(deleted).queryByRole('button', { name: /Select block/ })).not.toBeInTheDocument();

    const binary = row('assets/logo.png');
    expect(within(binary).getByText('Binary')).toBeInTheDocument();
    expect(within(binary).queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('opens the diff of a file, but not of a binary file', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open diff of src/cart.ts' }));
    expect(posted()).toEqual([{ type: 'openReviewDiff', runId: RUN_ID, path: 'src/cart.ts' }]);
    expect(screen.queryByRole('button', { name: 'Open diff of assets/logo.png' })).not.toBeInTheDocument();
    expect(within(row('assets/logo.png')).getByText('logo.png')).toBeInTheDocument();
  });

  it('keeps and reverts single files and all pending files', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Keep src/cart.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert docs/vouchers.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert 5 files' }));
    expect(posted()).toEqual([
      { type: 'reviewFiles', runId: RUN_ID, decision: 'kept', paths: ['src/cart.ts'] },
      { type: 'reviewFiles', runId: RUN_ID, decision: 'reverted', paths: ['docs/vouchers.md'] },
      { type: 'reviewFiles', runId: RUN_ID, decision: 'kept' },
      { type: 'reviewFiles', runId: RUN_ID, decision: 'reverted' },
    ]);
  });

  it('asks before Revert all, with the safe choice focused', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Revert all' }));
    expect(posted()).toEqual([]);
    const question = within(card()).getByRole('group', { name: 'Revert 5 files?' });
    expect(question).toHaveAccessibleDescription(
      'Changed files go back to how they were before the run, and files the run added are deleted.',
    );
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Cancel' }));
    // One decision at a time: Keep all waits until the question is answered.
    expect(screen.queryByRole('button', { name: 'Keep all' })).not.toBeInTheDocument();
    fireEvent.click(within(question).getByRole('button', { name: 'Revert 5 files' }));
    expect(posted()).toEqual([{ type: 'reviewFiles', runId: RUN_ID, decision: 'reverted' }]);
    expect(screen.queryByRole('group', { name: 'Revert 5 files?' })).not.toBeInTheDocument();
  });

  it('cancels Revert all with Cancel or Escape and gives the focus back', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Revert all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Revert 5 files?' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revert all' }));

    fireEvent.click(screen.getByRole('button', { name: 'Revert all' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Revert 5 files?' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revert all' }));
    expect(posted()).toEqual([]);
  });

  it('closes the question when nothing is left to revert', () => {
    renderCard(journalReview(RUN_ID));
    fireEvent.click(screen.getByRole('button', { name: 'Revert all' }));
    expect(screen.getByRole('group', { name: 'Revert 3 files?' })).toBeInTheDocument();
    // The files that can be reverted were kept one by one meanwhile.
    const review = journalReview(RUN_ID);
    host({
      type: 'review',
      review: {
        ...review,
        files: review.files.map((f) => (f.revertible ? { ...f, decision: 'kept' as const } : f)),
      },
    });
    expect(screen.queryByRole('group', { name: /^Revert/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep all' })).toBeEnabled();
  });

  it('waits with the confirmed revert while the host applies another decision', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Revert all' }));
    host({ type: 'review', review: { ...reviewFixture(RUN_ID), busy: true } });
    expect(screen.getByRole('button', { name: 'Revert 5 files' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('selects the block that changed a file', () => {
    renderCard();
    fireEvent.click(within(row('src/cart.ts')).getByRole('button', { name: 'Select block fix' }));
    expect(screen.getByRole('status', { name: 'Selection' })).toHaveTextContent('fix');
  });

  it('explains why a file cannot be reverted', () => {
    renderCard(journalReview(RUN_ID));
    const locked = row('test/fixtures/catalog-snapshot.json');
    const revert = within(locked).getByRole('button', { name: 'Revert test/fixtures/catalog-snapshot.json' });
    expect(revert).toBeDisabled();
    expect(revert).toHaveAccessibleDescription(
      "The state before the run wasn't saved, so this file can't be reverted.",
    );
    expect(
      within(locked).getByRole('button', { name: 'Keep test/fixtures/catalog-snapshot.json' }),
    ).toBeEnabled();
  });

  it('shows the error of a failed decision under its file', () => {
    renderCard(journalReview(RUN_ID));
    expect(within(row('src/cart.ts')).getByText(/another program has it open/)).toBeInTheDocument();
  });

  it('shows the notes of journal coverage and overlapping runs', () => {
    renderCard(journalReview(RUN_ID));
    expect(within(card()).getByText(/isn't a git repository/)).toBeInTheDocument();
    expect(within(card()).getByText(/Another run changed this folder/)).toBeInTheDocument();
  });

  it('marks worktree runs and disables Keep once the worktree is gone', () => {
    const { unmount } = renderCard(worktreeReview(RUN_ID));
    expect(within(card()).getByText('Worktree')).toBeInTheDocument();
    expect(within(card()).getByText(/separate git worktree/)).toBeInTheDocument();
    unmount();
    renderCard({ ...worktreeReview(RUN_ID), worktreeAvailable: false });
    expect(screen.getByRole('button', { name: 'Keep package-lock.json' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Revert all' })).toBeEnabled();
  });

  it('shows decided files as kept or reverted, without decision buttons', () => {
    renderCard(worktreeReview(RUN_ID));
    const kept = row('src/cart.ts');
    expect(within(kept).getByText('Kept')).toBeInTheDocument();
    expect(within(kept).queryByRole('button', { name: 'Keep src/cart.ts' })).not.toBeInTheDocument();
    expect(within(row('docs/vouchers.md')).getByText('Reverted')).toBeInTheDocument();
    expect(within(card()).getByText('3 to review')).toBeInTheDocument();
  });

  it('disables every decision while the host applies one', () => {
    renderCard({ ...reviewFixture(RUN_ID), busy: true });
    for (const button of within(card()).getAllByRole('button', { name: /^(Keep|Revert) / }))
      expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Revert all' })).toBeDisabled();
    expect(within(card()).getByText('Applying changes…')).toBeInTheDocument();
    // Looking at a diff changes nothing, so it stays available.
    expect(screen.getByRole('button', { name: 'Open diff of src/cart.ts' })).toBeEnabled();
  });

  it('collapses to a summary when every file is decided and expands again', () => {
    renderCard(doneReview(RUN_ID));
    expect(within(card()).getByRole('heading', { name: '4 files changed' })).toBeInTheDocument();
    expect(within(card()).getByText('3 kept, 1 reverted')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Changed files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep all' })).not.toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'Show review' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(show);
    expect(rows()).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Keep all' })).not.toBeInTheDocument();
  });

  it('keeps Keep all and Revert all while files that are not listed still wait', () => {
    renderCard({ ...doneReview(RUN_ID), omitted: 2, omittedPending: 2 });
    expect(within(card()).getByRole('heading', { name: '6 files changed' })).toBeInTheDocument();
    expect(within(card()).getByText('2 to review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep all' }));
    expect(posted()).toEqual([{ type: 'reviewFiles', runId: RUN_ID, decision: 'kept' }]);
  });

  it('hides and shows the file list', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Hide review' }));
    expect(screen.queryByRole('list', { name: 'Changed files' })).not.toBeInTheDocument();
    expect(within(card()).getByText('5 to review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show review' }));
    expect(rows()).toHaveLength(5);
  });

  it('collapses when the last pending file is decided', () => {
    renderCard();
    const decided = doneReview(RUN_ID);
    host({ type: 'review', review: decided });
    expect(screen.getByRole('button', { name: 'Show review' })).toBeInTheDocument();
    expect(within(card()).getByText('3 kept, 1 reverted')).toBeInTheDocument();
  });

  it('lists 500 files and says how many more are not listed', () => {
    // Role queries walk the whole tree; on 500 rows plain selectors keep the test fast.
    const { container } = renderCard(manyFilesReview(RUN_ID));
    expect(container.querySelector('h2')).toHaveTextContent('537 files changed');
    expect(container.querySelectorAll('li[data-path]')).toHaveLength(500);
    expect(container.querySelector('.wf-review-notes')).toHaveTextContent('37 more files are not listed');
  });

  it('keeps the keyboard focus in the card while decisions are applied', () => {
    renderCard();
    const keep = screen.getByRole('button', { name: 'Keep docs/vouchers.md' });
    keep.focus();
    fireEvent.click(keep);
    const decide = (review: RunReview) => host({ type: 'review', review });
    const base = reviewFixture(RUN_ID);
    decide({ ...base, busy: true });
    const kept = base.files.map((f) =>
      f.path === 'docs/vouchers.md' ? { ...f, decision: 'kept' as const } : f,
    );
    decide({ ...base, files: kept });
    // The next file waiting for a decision takes the focus.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep package-lock.json' }));

    fireEvent.click(screen.getByRole('button', { name: 'Keep all' }));
    decide({ ...base, files: base.files.map((f) => ({ ...f, decision: 'kept' as const })) });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show review' }));
  });

  it('leaves the focus alone when it moved out of the card', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Keep src/cart.ts' }));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    host({ type: 'review', review: doneReview(RUN_ID) });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('is reachable with the keyboard in reading order', async () => {
    const user = userEvent.setup();
    renderCard(reviewFixture(RUN_ID, reviewFixture(RUN_ID).files.slice(3)));
    const names: string[] = [];
    for (let i = 0; i < 11; i++) {
      await user.tab();
      names.push(
        document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '',
      );
    }
    expect(names).toEqual([
      'Hide review',
      'Open diff of src/cart.ts',
      'Select block implement',
      'Select block fix',
      'Keep src/cart.ts',
      'Revert src/cart.ts',
      'Open diff of src/checkout/vouchers.test.ts',
      'Select block fix',
      'Keep src/checkout/vouchers.test.ts',
      'Revert src/checkout/vouchers.test.ts',
      'Revert all',
    ]);
    await user.tab();
    expect(document.activeElement).toHaveTextContent('Keep all');
  });
});
