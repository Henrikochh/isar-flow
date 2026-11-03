/** Helpers for the live values and Simulation section tests: the store plus the live data provider. */
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  type HostToWorkflowEditor,
  type LiveContext,
  parseWorkflowText,
  type RunView,
  type SimulationFile,
  type SimulationState,
  validateWorkflow,
  type WorkflowDocumentState,
  workflowTemplate,
} from '@isar-flow/core';
import { AGENTS, CATALOG } from '../../../harness/fixtures';
import { Inspector } from '../../../src/views/workflow/inspector/Inspector';
import { LiveDataProvider } from '../../../src/views/workflow/live/LiveDataProvider';
import {
  initialWorkflowUiState,
  WorkflowStoreProvider,
  type WorkflowUiState,
} from '../../../src/views/workflow/store';

type Posted = { type: string; [key: string]: unknown };
type PostedWindow = { __posted?: Posted[] };

// jsdom implements neither; the kit's Select and the variable list scroll the active option into view.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

export const REVIEW_LOOP = workflowTemplate('review-loop', 'Review until approved');

export function resetPosted(): void {
  (window as unknown as PostedWindow).__posted = [];
}

export function posted(type?: string): Posted[] {
  const all = (window as unknown as PostedWindow).__posted ?? [];
  return type ? all.filter((m) => m.type === type) : all;
}

export function docFor(text: string = REVIEW_LOOP): WorkflowDocumentState {
  const parsed = parseWorkflowText(text);
  const semantic = parsed.workflow
    ? validateWorkflow(parsed.workflow, { agentIds: AGENTS.map((a) => a.id) })
    : [];
  const diagnostics = [...parsed.diagnostics, ...semantic];
  return {
    uri: 'file:///w/review-loop.workflow.yaml',
    fileName: 'review-loop.workflow.yaml',
    text,
    workflow: parsed.workflow,
    valid: parsed.valid && !diagnostics.some((d) => d.severity === 'error'),
    diagnostics,
  };
}

export function storeState(state: Partial<WorkflowUiState> = {}): WorkflowUiState {
  return { ...initialWorkflowUiState, doc: docFor(), agents: AGENTS, catalog: CATALOG, ...state };
}

/** Renders `ui` inside the store and the live data provider; `rerender` keeps both. */
export function renderLive(ui: ReactNode, state: Partial<WorkflowUiState> = {}) {
  const initialState = storeState(state);
  function Providers({ children }: { children: ReactNode }) {
    return (
      <WorkflowStoreProvider initialState={initialState}>
        <LiveDataProvider>{children}</LiveDataProvider>
      </WorkflowStoreProvider>
    );
  }
  return render(ui, { wrapper: Providers });
}

export function renderInspector(state: Partial<WorkflowUiState> = {}) {
  return renderLive(<Inspector />, state);
}

/** Delivers a host message, as the extension would. */
export function fromHost(message: HostToWorkflowEditor): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

export const STARTED = Date.now() - 5 * 60_000;

/** Live values of a finished review-loop run: tests failed once, the reviewer asked for changes. */
export function lastContext(overrides: Partial<LiveContext> = {}): LiveContext {
  return {
    runId: 'run-9',
    startedAt: STARTED,
    status: 'failure',
    inputs: { task: 'Add a dark mode toggle' },
    steps: {
      implement: { status: 'success', text: 'Added the toggle.' },
      tests: { status: 'success', exitCode: 1, output: '1 failed\n31 passed' },
      review: {
        status: 'success',
        text: '{"approved": false}',
        json: { approved: false, issues: ['Missing test', 'Typo in label'] },
      },
      needs_fix: { status: 'success', result: true },
      fix: { status: 'success', text: 'Fixed.' },
      review_loop: { status: 'failure', iterations: 5, exitReason: 'maxIterations' },
    },
    loops: { review_loop: { iteration: 5, index: 4 } },
    env: ['PATH'],
    secrets: ['API_TOKEN'],
    workflow: { name: 'Review until approved', file: '.isarflow/workflows/review-loop.workflow.yaml' },
    workspace: { root: '/work' },
    ...overrides,
  };
}

/** A shown run with the same story (the run the canvas shows). */
export function shownRun(overrides: Partial<RunView> = {}): RunView {
  const step = (output: Record<string, unknown>) => ({
    status: 'success' as const,
    executions: 1,
    logs: [],
    output: { status: 'success' as const, ...output },
  });
  return {
    runId: 'run-10',
    workflowName: 'Review until approved',
    status: 'success',
    startedAt: STARTED,
    durationMs: 60_000,
    inputs: { task: 'Add a dark mode toggle' },
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: {
      implement: step({ text: 'Added the toggle.' }),
      tests: step({ exitCode: 0, output: '32 passed' }),
      review: step({ json: { approved: true, issues: [] } }),
      needs_fix: step({ result: false }),
      review_loop: {
        ...step({ iterations: 2, exitReason: 'condition' }),
        loop: { iteration: 2, maxIterations: 5 },
      },
    },
    ...overrides,
  };
}

export function simulation(
  file: SimulationFile = {},
  overrides: Partial<SimulationState> = {},
): SimulationState {
  return {
    path: '.isarflow/simulations/review-loop.sim.yaml',
    exists: true,
    file,
    diagnostics: [],
    ...overrides,
  };
}
