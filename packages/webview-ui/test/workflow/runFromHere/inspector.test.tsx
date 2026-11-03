import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  blockHashes,
  type RunRecordSummary,
  type RunView,
  type StepRunView,
  type Workflow,
} from '@isar-flow/core';
import { AGENTS, CATALOG } from '../../../harness/fixtures';
import { Inspector } from '../../../src/views/workflow/inspector/Inspector';
import { RunFromHereHost } from '../../../src/views/workflow/runFromHere/RunFromHereHost';
import {
  initialWorkflowUiState,
  WorkflowStoreProvider,
  type WorkflowUiState,
} from '../../../src/views/workflow/store';
import { docFor, posted, resetPosted } from '../inspector/helpers';

beforeEach(resetPosted);

const doc = docFor();
const SOURCE_START = Date.now() - 5 * 60_000;

const step = (
  status: StepRunView['status'],
  output: Record<string, unknown>,
  extra: Partial<StepRunView> = {},
) =>
  ({
    status,
    executions: 1,
    durationMs: 1000,
    startedAt: 1000,
    output: { status, ...output },
    logs: [],
    ...extra,
  }) as StepRunView;

function failedRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-3',
    workflowName: 'Review until approved',
    status: 'failure',
    startedAt: SOURCE_START,
    durationMs: 61_000,
    inputs: { task: 'Add vouchers' },
    usage: { inputTokens: 0, outputTokens: 0 },
    blockHashes: blockHashes(doc.workflow as Workflow),
    steps: {
      implement: step('success', { text: 'Added vouchers.' }),
      review_loop: step('failure', { iterations: 5 }, { loop: { iteration: 5, maxIterations: 5 } }),
      tests: step('failure', { exitCode: 1, output: '1 failed' }, { iteration: 5 }),
    },
    ...overrides,
  };
}

const SOURCE: RunRecordSummary = {
  runId: 'run-3',
  workflowUri: doc.uri,
  workflowName: 'Review until approved',
  status: 'failure',
  startedAt: SOURCE_START,
  stoppedAt: 'tests',
};

function renderPanel(state: Partial<WorkflowUiState>) {
  return render(
    <WorkflowStoreProvider
      initialState={{
        ...initialWorkflowUiState,
        doc,
        agents: AGENTS,
        catalog: CATALOG,
        history: [SOURCE],
        ...state,
      }}
    >
      <Inspector />
      <RunFromHereHost workflowName="Review until approved" />
    </WorkflowStoreProvider>,
  );
}

describe('Run from here in the run output', () => {
  it('sits under the status line and opens the dialog for the block', () => {
    renderPanel({ selection: 'tests', run: failedRun(), runLive: false });
    const button = screen.getByRole('button', { name: 'Run from here' });
    expect(button).toHaveClass('if-btn--secondary');
    expect(button.querySelector('.codicon-run-below')).not.toBeNull();
    const status = document.querySelector('.wf-run-status') as HTMLElement;
    expect(status.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Run from tests' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run from here' }));
    expect(posted()).toEqual([
      { type: 'runFromHere', runId: 'run-3', stepId: 'tests', inputs: { task: 'Add vouchers' } },
    ]);
  });

  it('is offered for blocks that did not run', () => {
    renderPanel({ selection: 'fix', run: failedRun(), runLive: false });
    expect(screen.getByText('This block did not run in this run.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run from here' })).toBeEnabled();
  });

  it('is disabled with the reason while the run is running', () => {
    renderPanel({ selection: 'tests', run: failedRun({ status: 'running' }), runLive: true });
    const button = screen.getByRole('button', { name: 'Run from here' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Wait until the run has finished.');
    expect(button.parentElement).toHaveAttribute('title', 'Wait until the run has finished.');
  });

  it('marks a reused block and says where its result comes from', () => {
    const resumed = failedRun({
      runId: 'run-9',
      status: 'success',
      resumedFrom: { runId: 'run-3', stepId: 'tests' },
      steps: { implement: { ...step('success', { text: 'Added vouchers.' }), durationMs: 0, reused: true } },
    });
    renderPanel({ selection: 'implement', run: resumed, runLive: false });
    const status = document.querySelector('.wf-run-status') as HTMLElement;
    expect(within(status).getByText('Reused')).toHaveClass('if-chip');
    expect(
      screen.getByText("This block didn't run: its result comes from the run from 5 min ago."),
    ).toBeInTheDocument();
  });
});

describe('run summary of resumed and simulated runs', () => {
  it('names the run a resumed run continues and shows it', () => {
    const resumed = failedRun({
      runId: 'run-9',
      status: 'success',
      resumedFrom: { runId: 'run-3', stepId: 'tests' },
    });
    renderPanel({ run: resumed, runLive: false });
    expect(screen.getByText('Resumed from tests of the run from 5 min ago.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show that run' }));
    expect(posted()).toEqual([{ type: 'selectRun', runId: 'run-3' }]);
  });

  it('says that a simulated run executed nothing and links the mocks', () => {
    renderPanel({ run: failedRun({ status: 'success', simulated: true }), runLive: false });
    expect(
      screen.getByText('Nothing was executed. Results come from the simulation file.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit mocks' }));
    expect(posted()).toEqual([{ type: 'openSimulationFile' }]);
  });

  it('says in the present tense that a running simulation executes nothing', () => {
    renderPanel({ run: failedRun({ status: 'running', simulated: true }), runLive: true });
    expect(
      screen.getByText('Nothing is executed. Blocks return the mocks of the simulation file.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing was executed/)).toBeNull();
  });

  it('marks a simulated run next to its status, in the simulation tone', () => {
    renderPanel({ run: failedRun({ status: 'success', simulated: true }), runLive: false });
    const hero = document.querySelector('.wf-run-hero') as HTMLElement;
    expect(within(hero).getByText('Simulated')).toHaveClass('if-chip--simulated');
  });

  it('adds no chip to the status of a real run', () => {
    renderPanel({ run: failedRun({ status: 'success' }), runLive: false });
    const hero = document.querySelector('.wf-run-hero') as HTMLElement;
    expect(within(hero).queryByText('Simulated')).toBeNull();
  });
});
