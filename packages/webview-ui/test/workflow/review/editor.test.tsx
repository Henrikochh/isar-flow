import { fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { reduceRunEvent, type RunView } from '@isar-flow/core';
import { reviewFixture } from '../../../harness/reviews';
import { card, clearPosted, host, posted, renderEditor, stubLayout } from '../canvas/helpers';

vi.mock('../../../src/views/workflow/inspector/Inspector', () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

beforeAll(stubLayout);

const view = (runId: string): RunView =>
  reduceRunEvent(null, { type: 'run-start', runId, workflowName: 'W', startedAt: 0, inputs: {} });

describe('review card in the workflow editor', () => {
  it('appears for the shown run and selects the block that changed a file', () => {
    const { container } = renderEditor();
    host({ type: 'run', run: view('run-8'), live: false });
    host({ type: 'review', review: reviewFixture('run-8') });
    const region = screen.getByRole('region', { name: 'Review changes' });
    fireEvent.click(within(region).getAllByRole('button', { name: 'Select block implement' })[0]);
    expect(card(container, 'implement')).toHaveAttribute('aria-pressed', 'true');
    clearPosted();
    fireEvent.click(within(region).getByRole('button', { name: 'Keep all' }));
    expect(posted()).toEqual([{ type: 'reviewFiles', runId: 'run-8', decision: 'kept' }]);
  });

  it('goes away when another run is shown or a live run starts', () => {
    renderEditor();
    host({ type: 'run', run: view('run-8'), live: false });
    host({ type: 'review', review: reviewFixture('run-8') });
    host({ type: 'run', run: view('run-3'), live: false });
    expect(screen.queryByRole('region', { name: 'Review changes' })).not.toBeInTheDocument();

    host({ type: 'review', review: reviewFixture('run-3') });
    expect(screen.getByRole('region', { name: 'Review changes' })).toBeInTheDocument();
    host({
      type: 'runEvent',
      event: { type: 'run-start', runId: 'run-9', workflowName: 'W', startedAt: 1, inputs: {} },
    });
    expect(screen.queryByRole('region', { name: 'Review changes' })).not.toBeInTheDocument();
  });

  it('sits below a pending approval', () => {
    renderEditor();
    host({ type: 'run', run: view('run-8'), live: true });
    host({ type: 'review', review: reviewFixture('run-8') });
    host({
      type: 'approvalRequest',
      prompt: { requestId: 'q1', runId: 'run-8', stepId: 'implement', message: 'Merge it?' },
    });
    const approval = screen.getByText('Approval needed');
    const region = screen.getByRole('region', { name: 'Review changes' });
    expect(approval.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
