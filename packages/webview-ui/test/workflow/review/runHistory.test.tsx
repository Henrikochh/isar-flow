import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunRecordSummary } from '@isar-flow/core';
import { RECENT_RUNS } from '../../../harness/fixtures';
import { RunHistory } from '../../../src/views/workflow/inspector/workflow/RunHistory';
import { initialWorkflowUiState, WorkflowStoreProvider } from '../../../src/views/workflow/store';

function renderHistory(history: RunRecordSummary[]) {
  return render(
    <WorkflowStoreProvider initialState={{ ...initialWorkflowUiState, history }}>
      <RunHistory />
    </WorkflowStoreProvider>,
  );
}

describe('run history in the workflow panel', () => {
  it('shows files to review and the decisions of past runs', () => {
    const decided = {
      ...RECENT_RUNS[2],
      runId: 'run-4',
      review: { total: 3, kept: 3, reverted: 0, pending: 0 },
    };
    renderHistory([RECENT_RUNS[0], decided, RECENT_RUNS[2]]);
    const [toReview, done, plain] = within(screen.getByRole('list', { name: 'Run history' })).getAllByRole(
      'button',
    );
    expect(within(toReview).getByText('2 to review')).toHaveClass('if-chip--warning');
    expect(within(done).getByText('3 kept')).toBeInTheDocument();
    expect(plain).not.toHaveTextContent(/to review|kept|reverted/);
  });
});

describe('simulated and resumed runs in the run history', () => {
  it('marks them with chips', () => {
    renderHistory([
      { ...RECENT_RUNS[0], runId: 'run-9', simulated: true },
      { ...RECENT_RUNS[0], runId: 'run-8', resumedFrom: { runId: 'run-3', stepId: 'tests' } },
      RECENT_RUNS[2],
    ]);
    const [simulated, resumed, plain] = within(
      screen.getByRole('list', { name: 'Run history' }),
    ).getAllByRole('button');
    expect(within(simulated).getByText('Simulated')).toHaveClass('if-chip');
    expect(within(resumed).getByText('Resumed')).toHaveAttribute('title', 'Resumed from tests');
    expect(plain).not.toHaveTextContent(/Simulated|Resumed/);
  });
});
