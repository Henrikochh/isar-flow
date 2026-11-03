import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RECENT_RUNS, WORKFLOWS } from '../../harness/fixtures';
import { renderSidebar, resetPosted } from './helpers';

beforeEach(resetPosted);

const simulated = { ...RECENT_RUNS[0], runId: 'run-9', simulated: true };
const resumed = { ...RECENT_RUNS[1], runId: 'run-8', resumedFrom: { runId: 'run-6', stepId: 'tests' } };

describe('simulated and resumed runs in the sidebar', () => {
  it('marks recent runs', () => {
    renderSidebar({ tab: 'workflows', recentRuns: [simulated, resumed, RECENT_RUNS[2]] });
    const [first, second, third] = within(screen.getByRole('list', { name: 'Recent runs' })).getAllByRole(
      'button',
    );
    expect(within(first).getByText('Simulated')).toHaveClass('if-chip');
    expect(within(second).getByText('Resumed')).toHaveAttribute('title', 'Resumed from tests');
    expect(third).not.toHaveTextContent(/Simulated|Resumed/);
  });

  it("marks a workflow's last run", () => {
    renderSidebar({
      tab: 'workflows',
      workflows: [
        { ...WORKFLOWS[0], lastRun: simulated },
        { ...WORKFLOWS[1], lastRun: resumed },
      ],
    });
    const review = screen.getByRole('button', { name: /^Review until approved/ });
    expect(within(review).getByText('Simulated')).toHaveClass('if-chip');
    const fix = screen.getByRole('button', { name: /^Fix failing tests/ });
    expect(within(fix).getByText('Resumed')).toHaveAttribute('title', 'Resumed from tests');
  });
});
