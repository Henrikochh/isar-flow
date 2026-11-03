import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, RunView } from '@isar-flow/core';
import {
  initialWorkflowUiState,
  useWorkflowActions,
  useWorkflowState,
  workflowUiReducer,
  WorkflowStoreProvider,
  type WorkflowActions,
  type WorkflowUiAction,
  type WorkflowUiState,
} from '../../../src/views/workflow/store';
import { clearPosted, host, posted } from '../canvas/helpers';

const reduce = (state: WorkflowUiState, ...actions: WorkflowUiAction[]) =>
  actions.reduce(workflowUiReducer, state);

function pastRun(runId: string): RunView {
  return {
    runId,
    workflowName: 'Review until approved',
    status: 'failure',
    startedAt: 1000,
    durationMs: 4000,
    inputs: { task: 'Add vouchers' },
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: {},
  };
}

const START: RunEvent = { type: 'run-start', runId: 'run-9', workflowName: 'w', startedAt: 5, inputs: {} };

describe('workflow store: run from here requests', () => {
  const requested = reduce(initialWorkflowUiState, {
    type: 'requestResume',
    runId: 'run-3',
    stepId: 'tests',
  });

  it('keeps the request until it is cleared', () => {
    expect(requested.resumeRequest).toEqual({ runId: 'run-3', stepId: 'tests' });
    expect(reduce(requested, { type: 'clearResumeRequest' }).resumeRequest).toBeNull();
  });

  it('keeps the request while runs are shown, also another one', () => {
    const shown = reduce(requested, { type: 'run', run: pastRun('run-7'), live: false });
    expect(shown.resumeRequest).toEqual({ runId: 'run-3', stepId: 'tests' });
    const target = reduce(shown, { type: 'run', run: pastRun('run-3'), live: false });
    expect(target.resumeRequest).toEqual({ runId: 'run-3', stepId: 'tests' });
  });

  it('drops the request when the host shows no run (the run is gone)', () => {
    expect(reduce(requested, { type: 'run', run: null, live: false }).resumeRequest).toBeNull();
  });

  it('drops the request when a live run starts', () => {
    const started = reduce(
      requested,
      { type: 'run', run: pastRun('run-3'), live: false },
      { type: 'runEvent', event: START },
    );
    expect(started.resumeRequest).toBeNull();
  });

  it('keeps the request while other events of the shown run arrive', () => {
    const live = reduce(initialWorkflowUiState, { type: 'runEvent', event: START });
    const asked = reduce(live, { type: 'requestResume', runId: 'run-9', stepId: 'tests' });
    const later = reduce(asked, {
      type: 'runEvent',
      event: { type: 'step-start', runId: 'run-9', stepId: 'implement', stepType: 'agent', at: 6 },
    });
    expect(later.resumeRequest).toEqual({ runId: 'run-9', stepId: 'tests' });
  });

  it('starts without a request', () => {
    expect(initialWorkflowUiState.resumeRequest).toBeNull();
  });
});

describe('workflow store: run from here and simulate actions', () => {
  let actions: WorkflowActions;
  let state: WorkflowUiState;

  function Probe() {
    actions = useWorkflowActions();
    state = useWorkflowState();
    return null;
  }

  beforeEach(() => {
    clearPosted();
    render(
      <WorkflowStoreProvider>
        <Probe />
      </WorkflowStoreProvider>,
    );
  });

  it('posts runFromHere, simulate and openSimulationFile', () => {
    actions.runFromHere('run-3', 'tests', { task: 'Add vouchers' });
    actions.simulate({ task: 'Try it' });
    actions.openSimulationFile();
    expect(posted()).toEqual([
      { type: 'runFromHere', runId: 'run-3', stepId: 'tests', inputs: { task: 'Add vouchers' } },
      { type: 'simulate', inputs: { task: 'Try it' } },
      { type: 'openSimulationFile' },
    ]);
  });

  it('asks the host to show the requested run when another one is shown', () => {
    host({ type: 'run', run: pastRun('run-7'), live: false });
    act(() => actions.requestResume('run-3', 'tests'));
    expect(posted()).toEqual([{ type: 'selectRun', runId: 'run-3' }]);
    expect(state.resumeRequest).toEqual({ runId: 'run-3', stepId: 'tests' });
  });

  it('does not ask for the run when it is already shown', () => {
    host({ type: 'run', run: pastRun('run-3'), live: false });
    act(() => actions.requestResume('run-3', 'review'));
    expect(posted()).toEqual([]);
    expect(state.resumeRequest).toEqual({ runId: 'run-3', stepId: 'review' });
    act(() => actions.clearResumeRequest());
    expect(state.resumeRequest).toBeNull();
  });
});
