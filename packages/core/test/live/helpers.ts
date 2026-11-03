import type { LiveContext, RunView, StepRunView } from '../../src/run/types';

export function stepView(extra: Partial<StepRunView> = {}): StepRunView {
  return { status: 'success', executions: 1, logs: [], ...extra };
}

export function runView(extra: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-1',
    workflowName: 'Review loop',
    status: 'success',
    startedAt: 1000,
    inputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: {},
    ...extra,
  };
}

export function liveCtx(extra: Partial<LiveContext> = {}): LiveContext {
  return {
    runId: 'run-1',
    startedAt: 1000,
    status: 'success',
    inputs: {},
    steps: {},
    loops: {},
    env: [],
    secrets: [],
    workflow: { name: 'Review loop', file: '/ws/.isarflow/workflows/review.workflow.yaml' },
    workspace: { root: '/ws' },
    ...extra,
  };
}
