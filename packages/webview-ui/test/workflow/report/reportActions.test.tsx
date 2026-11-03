import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunView } from '@isar-flow/core';
import { initialWorkflowUiState, WorkflowStoreProvider } from '../../../src/views/workflow/store';
import { RunsMenu } from '../../../src/views/workflow/topbar/RunsMenu';
import { posted, renderInspector, resetPosted } from '../inspector/helpers';

beforeEach(() => {
  resetPosted();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const run = (status: RunView['status']): RunView => ({
  runId: 'run-7',
  workflowName: 'Review until approved',
  status,
  startedAt: Date.now() - 60_000,
  durationMs: status === 'running' ? undefined : 52_000,
  inputs: { task: 'Add voucher codes' },
  usage: { inputTokens: 0, outputTokens: 0 },
  steps: {},
});

describe('report actions in the run summary', () => {
  it('exports a finished run and copies it for a PR description', () => {
    renderInspector({ run: run('success'), runLive: false });
    fireEvent.click(screen.getByRole('button', { name: 'Export report…' }));
    expect(posted()).toEqual([{ type: 'runReport', runId: 'run-7', action: 'export' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy for PR description' }));
    expect(posted()[1]).toEqual({ type: 'runReport', runId: 'run-7', action: 'copyForPr' });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('button', { name: 'Copy for PR description' })).toBeInTheDocument();
  });

  it('offers no report while the run is going', () => {
    renderInspector({ run: run('running'), runLive: true });
    expect(screen.queryByRole('button', { name: 'Export report…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy for PR description' })).toBeNull();
  });

  it('offers a report for failed and cancelled runs too', () => {
    renderInspector({ run: run('failure'), runLive: false });
    expect(screen.getByRole('button', { name: 'Export report…' })).toBeInTheDocument();
  });
});

describe('report actions in the Runs menu', () => {
  it('lists them for the finished run on the canvas', () => {
    render(
      <WorkflowStoreProvider initialState={{ ...initialWorkflowUiState, run: run('success') }}>
        <RunsMenu elapsed={undefined} />
      </WorkflowStoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Run history|Succeeded/ }));
    const menu = screen.getByRole('menu', { name: 'Runs' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy for PR description' }));
    expect(posted()).toEqual([{ type: 'runReport', runId: 'run-7', action: 'copyForPr' }]);
    expect(within(menu).getByRole('menuitem', { name: 'Copied' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export report…' }));
    expect(posted()[1]).toEqual({ type: 'runReport', runId: 'run-7', action: 'export' });
    expect(screen.queryByRole('menu', { name: 'Runs' })).toBeNull();
  });

  it('leaves them out while the shown run is going', () => {
    render(
      <WorkflowStoreProvider initialState={{ ...initialWorkflowUiState, run: run('running'), runLive: true }}>
        <RunsMenu elapsed={1000} />
      </WorkflowStoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Run history|Live run/ }));
    expect(screen.queryByRole('menuitem', { name: 'Export report…' })).toBeNull();
  });
});

describe('origin in the run summary', () => {
  it('says how the run was started', () => {
    renderInspector({ run: { ...run('success'), origin: { kind: 'copilot' } }, runLive: false });
    expect(screen.getByText('Started by Copilot.')).toBeInTheDocument();
  });
});
