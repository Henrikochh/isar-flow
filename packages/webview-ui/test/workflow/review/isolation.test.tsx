import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWorkflowOps, type WorkflowOp } from '@isar-flow/core';
import { AGENTS, CATALOG } from '../../../harness/fixtures';
import { WorkflowPanel } from '../../../src/views/workflow/inspector/workflow/WorkflowPanel';
import { initialWorkflowUiState, WorkflowStoreProvider } from '../../../src/views/workflow/store';
import { clearPosted, docFor, postedOps, REVIEW_TEXT } from '../canvas/helpers';

const withIsolation = (set: Record<string, unknown>) =>
  applyWorkflowOps(REVIEW_TEXT, [{ op: 'updateWorkflow', set }]).text;

function renderPanel(text = REVIEW_TEXT) {
  clearPosted();
  return render(
    <WorkflowStoreProvider
      initialState={{ ...initialWorkflowUiState, doc: docFor(text), agents: AGENTS, catalog: CATALOG }}
    >
      <WorkflowPanel />
    </WorkflowStoreProvider>,
  );
}

const runIn = (name: string) => screen.getByRole('radio', { name });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('isolation settings in the workflow panel', () => {
  it('runs in the workspace by default and offers a separate worktree', () => {
    renderPanel();
    expect(screen.getByRole('radiogroup', { name: 'Run in' })).toBeInTheDocument();
    expect(runIn('Workspace')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/the run works on a copy of this git repository/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Setup commands' })).not.toBeInTheDocument();
    fireEvent.click(runIn('Separate worktree'));
    expect(postedOps()).toEqual<WorkflowOp[]>([{ op: 'updateWorkflow', set: { isolation: 'worktree' } }]);
  });

  it('edits the setup commands of a worktree run', () => {
    renderPanel(withIsolation({ isolation: 'worktree', setup: ['npm ci'] }));
    expect(runIn('Separate worktree')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Run first in the worktree, for example npm ci.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Setup command 1' })).toHaveValue('npm ci');

    fireEvent.click(screen.getByRole('button', { name: 'Add command' }));
    const second = screen.getByRole('textbox', { name: 'Setup command 2' });
    fireEvent.change(second, { target: { value: 'npm run build' } });
    fireEvent.blur(second);
    expect(postedOps()).toEqual<WorkflowOp[]>([
      { op: 'updateWorkflow', set: { setup: ['npm ci', 'npm run build'] } },
    ]);
  });

  it('removes the setup key when the last command is removed', () => {
    renderPanel(withIsolation({ isolation: 'worktree', setup: ['npm ci'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Setup command npm ci' }));
    act(() => vi.advanceTimersByTime(400));
    expect(postedOps()).toEqual<WorkflowOp[]>([{ op: 'updateWorkflow', set: {}, unset: ['setup'] }]);
  });

  it('shows setup commands that cannot run in the workspace, so they can be removed', () => {
    renderPanel(withIsolation({ setup: ['npm ci'] }));
    expect(runIn('Workspace')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox', { name: 'Setup command 1' })).toHaveValue('npm ci');
    expect(
      screen.getByText('These only run in a separate worktree. Choose Separate worktree or remove them.'),
    ).toBeInTheDocument();
  });

  it('switches back to the workspace at once when there are no setup commands', () => {
    renderPanel(withIsolation({ isolation: 'worktree' }));
    fireEvent.click(runIn('Workspace'));
    expect(postedOps()).toEqual<WorkflowOp[]>([
      { op: 'updateWorkflow', set: {}, unset: ['isolation', 'setup'] },
    ]);
  });

  it('asks before removing setup commands when switching back to the workspace', () => {
    renderPanel(withIsolation({ isolation: 'worktree', setup: ['npm ci'] }));
    fireEvent.click(runIn('Workspace'));
    expect(postedOps()).toEqual([]);
    expect(screen.getByText(/Switching to Workspace removes them/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Switching to Workspace removes them/)).not.toBeInTheDocument();
    expect(postedOps()).toEqual([]);

    fireEvent.click(runIn('Workspace'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Workspace' }));
    expect(postedOps()).toEqual<WorkflowOp[]>([
      { op: 'updateWorkflow', set: {}, unset: ['isolation', 'setup'] },
    ]);
  });
});
