import { describe, expect, it } from 'vitest';
import type { AskPrompt, WorkflowTriggerState } from '@isar-flow/core';
import {
  initialWorkflowUiState,
  workflowUiReducer,
  type WorkflowUiAction,
  type WorkflowUiState,
} from '../../src/views/workflow/store';

const run = (state: WorkflowUiState, ...actions: WorkflowUiAction[]) =>
  actions.reduce(workflowUiReducer, state);

const ask = (requestId: string, stepId = 'pick-env'): AskPrompt => ({
  requestId,
  runId: 'run-1',
  stepId,
  question: 'Which environment should I deploy to?',
  choices: ['dev', 'staging', 'prod'],
  default: 'dev',
});

describe('workflow store: asks and triggers', () => {
  it('starts without asks and without trigger state', () => {
    expect(initialWorkflowUiState.asks).toEqual([]);
    expect(initialWorkflowUiState.triggers).toBeNull();
  });

  it('keeps pending asks in arrival order, replaces a repeated request and drops resolved ones', () => {
    const first = ask('a-1');
    const second = ask('a-2', 'release-notes');
    const state = run(
      initialWorkflowUiState,
      { type: 'askRequest', prompt: first },
      { type: 'askRequest', prompt: second },
      { type: 'askRequest', prompt: { ...first, question: 'Where to?' } },
    );
    expect(state.asks.map((a) => a.requestId)).toEqual(['a-2', 'a-1']);
    expect(state.asks[1].question).toBe('Where to?');
    expect(run(state, { type: 'askResolved', requestId: 'a-2' }).asks.map((a) => a.requestId)).toEqual([
      'a-1',
    ]);
    expect(run(state, { type: 'askResolved', requestId: 'unknown' }).asks).toHaveLength(2);
  });

  it('shows the latest trigger state', () => {
    const triggers: WorkflowTriggerState = {
      triggers: [{ kind: 'schedule', label: 'Every hour', every: '1h', everyMs: 3_600_000 }],
      status: 'active',
      nextRunAt: 1000,
    };
    const state = run(initialWorkflowUiState, { type: 'triggers', triggers });
    expect(state.triggers).toEqual(triggers);
    const paused = run(state, {
      type: 'triggers',
      triggers: { ...triggers, status: 'paused', pausedReason: 'limited' },
    });
    expect(paused.triggers?.pausedReason).toBe('limited');
  });
});
