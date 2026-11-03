import { fireEvent, screen, within } from '@testing-library/react';
import type { RunView } from '@isar-flow/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { docFor, posted, REVIEW_LOOP, renderInspector, resetPosted } from './helpers';

beforeEach(resetPosted);

function makeRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-1',
    workflowName: 'Review until approved',
    status: 'running',
    startedAt: Date.now() - 5000,
    inputs: { task: 'Add voucher codes' },
    usage: { inputTokens: 23_600, outputTokens: 1_560 },
    activeStepId: 'review_loop',
    steps: {
      implement: {
        status: 'success',
        executions: 1,
        durationMs: 1700,
        detail: 'Implement the following task in this repository:\nAdd voucher codes\n',
        output: {
          status: 'success',
          text: 'Added voucher support.',
          model: 'litellm/claude-sonnet',
          usage: { inputTokens: 18_400, outputTokens: 1_250 },
          turns: 4,
        },
        logs: [
          { stream: 'tool', text: 'readFile src/checkout.ts → 214 lines\n' },
          { stream: 'agent', text: 'Added voucher support.' },
        ],
      },
      review_loop: { status: 'running', executions: 1, loop: { iteration: 2, maxIterations: 5 }, logs: [] },
      tests: {
        status: 'failure',
        executions: 2,
        iteration: 2,
        durationMs: 1200,
        detail: 'npm test',
        error: 'Command exited with code 1',
        output: { status: 'failure', exitCode: 1, stdout: '', stderr: '', output: '', timedOut: false },
        logs: [
          { stream: 'stdout', text: '> vitest run\n' },
          { stream: 'stderr', text: ' ✗ applies the voucher once\n' },
        ],
      },
      review: {
        status: 'success',
        executions: 1,
        iteration: 1,
        durationMs: 2100,
        output: {
          status: 'success',
          text: '{"approved":false}',
          json: { approved: false, issues: ['Missing test'] },
          model: 'vscode/copilot/gpt-4.1',
          usage: { inputTokens: 5200, outputTokens: 310 },
          turns: 2,
        },
        logs: [],
      },
    },
    ...overrides,
  };
}

describe('Run output tab', () => {
  it('shows console status, exit code and logs with stderr marked', () => {
    renderInspector({ selection: 'tests', run: makeRun(), runLive: true });
    expect(screen.getByRole('tab', { name: /Run output/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Failed', { selector: '.wf-run-status-label' })).toBeInTheDocument();
    expect(screen.getByText('Iteration 2')).toBeInTheDocument();
    expect(screen.getByText('Exit code 1')).toBeInTheDocument();
    expect(screen.getByText('Command exited with code 1')).toBeInTheDocument();
    const log = screen.getByRole('log', { name: 'Output' });
    expect(within(log).getByText('✗ applies the voucher once', { exact: false })).toHaveClass(
      'wf-log-line--err',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(posted()).toContainEqual({
      type: 'copyToClipboard',
      text: '> vitest run\n ✗ applies the voucher once\n',
    });
  });

  it('switches between settings and run output', () => {
    renderInspector({ selection: 'tests', run: makeRun(), runLive: true });
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByLabelText('Command')).toHaveValue('npm test');
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('pretty-prints JSON answers with tokens and turns', () => {
    renderInspector({ selection: 'review', run: makeRun(), runLive: true });
    expect(screen.getByText('Answer (JSON)')).toBeInTheDocument();
    expect(screen.getByText(/"approved": false/)).toBeInTheDocument();
    expect(screen.getByText('5.2k in')).toBeInTheDocument();
    expect(screen.getByText('310 out')).toBeInTheDocument();
    const metrics = screen.getByRole('group', { name: 'Time and tokens' });
    expect(within(metrics).getByText('Turns', { selector: 'dt' }).nextElementSibling).toHaveTextContent('2');
  });

  it('lists tool calls and the text answer of an agent', () => {
    renderInspector({ selection: 'implement', run: makeRun(), runLive: true });
    expect(screen.getByText('readFile src/checkout.ts → 214 lines')).toBeInTheDocument();
    expect(screen.getByText('Added voucher support.', { selector: '.wf-answer' })).toBeInTheDocument();
    // The prompt sent to the agent starts collapsed and previews its first line.
    const toggle = screen.getByRole('button', { name: /Sent to the agent/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText(/Add voucher codes/, { selector: 'pre' })).toBeInTheDocument();
  });

  it('says when a block has not run yet', () => {
    renderInspector({ selection: 'fix', run: makeRun(), runLive: true });
    expect(screen.getByText('This block has not started yet.')).toBeInTheDocument();
  });

  it('answers a pending approval', () => {
    const text = `${REVIEW_LOOP}  - id: ship_it\n    type: approval\n    message: Merge?\n`;
    const run = makeRun({
      steps: { ship_it: { status: 'running', executions: 1, detail: 'Merge?', logs: [] } },
    });
    renderInspector({
      doc: docFor(text),
      selection: 'ship_it',
      run,
      runLive: true,
      approvals: [{ requestId: 'req-1', runId: 'run-1', stepId: 'ship_it', message: 'Merge?' }],
    });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Ship it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(posted()).toContainEqual({
      type: 'approval',
      requestId: 'req-1',
      approved: true,
      comment: 'Ship it',
    });
  });
});

describe('Run summary', () => {
  it('shows the run and its blocks when nothing is selected', () => {
    renderInspector({ run: makeRun(), runLive: true });
    expect(screen.getByRole('tab', { name: 'Run summary' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Running' })).toBeInTheDocument();
    expect(screen.getByText('Add voucher codes')).toBeInTheDocument();
    const blocks = screen.getByRole('table', { name: 'Blocks in this run' });
    expect(within(blocks).getAllByRole('button')).toHaveLength(6);
    fireEvent.click(within(blocks).getByRole('button', { name: 'tests: Failed' }));
    expect(screen.getByRole('log', { name: 'Output' })).toBeInTheDocument();
  });

  it('keeps the workflow settings one tab away', () => {
    renderInspector({ run: makeRun(), runLive: true });
    fireEvent.click(screen.getByRole('tab', { name: 'Workflow' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Review until approved');
  });

  it('closes a past run', () => {
    renderInspector({
      run: makeRun({ status: 'failure', durationMs: 61_000, error: 'Loop limit reached' }),
      runLive: false,
    });
    expect(screen.getByText('Loop limit reached')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(posted()).toContainEqual({ type: 'selectRun', runId: null });
  });
});
