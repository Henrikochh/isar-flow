import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveRunSummary, WorkflowSummary } from '@isar-flow/core';
import { RECENT_RUNS, WORKFLOWS } from '../../harness/fixtures';
import { makeState, postedOfType, renderSidebar, resetPosted, sendState } from './helpers';

beforeEach(resetPosted);

const REVIEW = WORKFLOWS[0];
const active = (startedAt = Date.now() - 5_000): ActiveRunSummary => ({
  runId: 'run-9',
  workflowUri: REVIEW.uri,
  workflowName: REVIEW.name,
  startedAt,
});

describe('Workflows tab', () => {
  it('lists workflows with path and last run, and opens one on click', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows' });
    const row = screen.getByRole('button', { name: /^Review until approved/ });
    expect(within(row).getByTitle(REVIEW.relativePath)).toBeInTheDocument();
    expect(row).toHaveTextContent('Succeeded');
    await user.click(row);
    expect(postedOfType('openWorkflow')).toEqual([{ type: 'openWorkflow', uri: REVIEW.uri }]);
  });

  it('gives workflow and run names that may be cut off a tooltip with the full text', () => {
    renderSidebar({ tab: 'workflows' });
    const row = screen.getByRole('button', { name: /^Fix failing tests/ });
    expect(within(row).getByTitle('Fix failing tests')).toHaveTextContent('Fix failing tests');
    const runs = screen.getByRole('list', { name: 'Recent runs' });
    const failed = within(runs).getByRole('button', { name: /Fix failing tests/ });
    expect(within(failed).getByTitle('Fix failing tests')).toHaveTextContent('Fix failing tests');
    expect(within(failed).getByTitle(RECENT_RUNS[1].error as string)).toHaveTextContent("Loop 'fix_loop'");
  });

  it('runs a workflow', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows' });
    await user.click(screen.getByRole('button', { name: 'Run Review until approved' }));
    expect(postedOfType('runWorkflow')).toEqual([{ type: 'runWorkflow', uri: REVIEW.uri }]);
  });

  it('shows a spinner and Stop for an active run, and moves focus from Run to Stop', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows' });
    await user.click(screen.getByRole('button', { name: 'Run Review until approved' }));
    sendState(makeState({ tab: 'workflows', activeRuns: [active()] }));

    expect(screen.queryByRole('button', { name: 'Run Review until approved' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('status', { name: 'Running' }).length).toBeGreaterThan(0);
    const stop = screen.getByRole('button', { name: 'Stop Review until approved' });
    expect(stop).toHaveFocus();
    await user.click(stop);
    expect(postedOfType('cancelRun')).toEqual([{ type: 'cancelRun', runId: 'run-9' }]);
    // Only the workflow of the active run changes.
    expect(screen.getByRole('button', { name: 'Run Fix failing tests' })).toBeEnabled();
  });

  it('shows how long an active run has been going, ticking every second', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 26, 9, 31, 10));
      renderSidebar({ tab: 'workflows', activeRuns: [active(Date.UTC(2026, 9, 26, 9, 30))] });
      const row = screen.getByRole('button', { name: /^Review until approved/ });
      expect(row).toHaveTextContent('Running');
      expect(row).toHaveTextContent('1 m 10 s');
      expect(row).not.toHaveTextContent('Succeeded');
      act(() => vi.advanceTimersByTime(3_000));
      expect(row).toHaveTextContent('1 m 13 s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists active runs above the finished ones in recent runs', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows', activeRuns: [active()] });
    const runs = within(screen.getByRole('list', { name: 'Recent runs' })).getAllByRole('button');
    expect(runs).toHaveLength(RECENT_RUNS.length + 1);
    expect(runs[0]).toHaveTextContent('Review until approved');
    expect(within(runs[0]).getByRole('img', { name: 'Running' })).toBeInTheDocument();
    await user.click(runs[0]);
    expect(postedOfType('openRun')).toEqual([{ type: 'openRun', runId: 'run-9', workflowUri: REVIEW.uri }]);
  });

  it('flags workflows with problems and does not offer to run them', () => {
    renderSidebar({ tab: 'workflows' });
    const row = screen.getByRole('button', { name: /^Draft release notes/ });
    expect(row).toHaveTextContent('Has problems');
    expect(screen.getByRole('button', { name: 'Run Draft release notes' })).toBeDisabled();
  });

  it('opens a run from the recent runs list', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows' });
    const runs = screen.getByRole('list', { name: 'Recent runs' });
    await user.click(within(runs).getByRole('button', { name: /Fix failing tests/ }));
    expect(postedOfType('openRun')).toEqual([
      { type: 'openRun', runId: RECENT_RUNS[1].runId, workflowUri: RECENT_RUNS[1].workflowUri },
    ]);
    expect(runs).toHaveTextContent("Loop 'fix_loop' reached its limit");
  });

  it('shows the empty state and hides recent runs when there is nothing yet', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows', workflows: [], recentRuns: [] });
    expect(screen.getByText('No workflows yet')).toBeInTheDocument();
    expect(screen.getByText('Chain agents, console commands, loops and conditions.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent runs' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(screen.getByRole('form', { name: 'New workflow' })).toBeInTheDocument();
  });

  it('falls back to the file name for workflows without a name', () => {
    const nameless = {
      uri: 'file:///w/tools/cleanup.workflow.yaml',
      name: '',
      relativePath: 'tools/cleanup.workflow.yaml',
      valid: true,
      stepCount: 0,
    } as WorkflowSummary;
    renderSidebar({ tab: 'workflows', workflows: [nameless, nameless] });
    expect(screen.getAllByRole('button', { name: /^cleanup/ })).toHaveLength(2);
    expect(screen.getAllByText('Not run yet')).toHaveLength(2);
    expect(screen.getAllByText('No blocks yet')).toHaveLength(2);
  });

  it('shows the block count of a workflow that has not run as its own chip', () => {
    const fresh = {
      uri: 'file:///w/fresh.workflow.yaml',
      name: 'Fresh',
      relativePath: 'fresh.workflow.yaml',
      valid: true,
      stepCount: 3,
    } as WorkflowSummary;
    renderSidebar({ tab: 'workflows', workflows: [fresh], recentRuns: [] });
    expect(screen.getByText('Not run yet')).toBeInTheDocument();
    expect(screen.getByText('3 blocks')).toHaveClass('if-chip');
  });
});

describe('New workflow card', () => {
  it('creates a workflow from a template card', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows' });
    await user.click(screen.getByRole('button', { name: 'New workflow' }));
    const templates = screen.getByRole('radiogroup', { name: 'Template' });
    expect(within(templates).getByRole('radio', { name: /Blank/ })).toBeChecked();
    expect(templates).toHaveTextContent('Implement, test and review until approved');
    expect(templates).toHaveTextContent('Run tests and fix failures until they pass');

    await user.type(screen.getByLabelText('Name'), 'Fix flaky tests');
    await user.click(within(templates).getByRole('radio', { name: /Test and fix/ }));
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(postedOfType('createWorkflow')).toEqual([
      { type: 'createWorkflow', name: 'Fix flaky tests', template: 'test-fix' },
    ]);
  });

  it('moves between templates with arrow keys', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows' });
    await user.click(screen.getByRole('button', { name: 'New workflow' }));
    within(screen.getByRole('radiogroup', { name: 'Template' }))
      .getByRole('radio', { name: /Blank/ })
      .focus();
    await user.keyboard('{ArrowDown}');
    const review = screen.getByRole('radio', { name: /Review loop/ });
    expect(review).toBeChecked();
    expect(review).toHaveFocus();
  });

  it('refuses an empty or existing name', async () => {
    const user = userEvent.setup();
    renderSidebar({ tab: 'workflows' });
    await user.click(screen.getByRole('button', { name: 'New workflow' }));
    await user.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(screen.getByText('Enter a name for the workflow.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'fix failing tests');
    expect(
      screen.getByText('A workflow named Fix failing tests already exists. Choose another name.'),
    ).toBeInTheDocument();
    expect(postedOfType('createWorkflow')).toEqual([]);
  });
});
