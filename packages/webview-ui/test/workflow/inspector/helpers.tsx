import { act, render } from '@testing-library/react';
import {
  type HostToWorkflowEditor,
  parseWorkflowText,
  validateWorkflow,
  type WorkflowDocumentState,
  type WorkflowOp,
  workflowTemplate,
} from '@isar-flow/core';
import { AGENTS, CATALOG, RECENT_RUNS } from '../../../harness/fixtures';
import { Inspector } from '../../../src/views/workflow/inspector/Inspector';
import { initialWorkflowUiState, WorkflowStoreProvider, type WorkflowUiState } from '../../../src/views/workflow/store';

type PostedWindow = { __posted?: unknown[] };

// jsdom implements neither; the kit's Select and the variable list scroll the active option into view.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

export const REVIEW_LOOP = workflowTemplate('review-loop', 'Review until approved');

export function resetPosted(): void {
  (window as unknown as PostedWindow).__posted = [];
}

export function posted(): { type: string; [key: string]: unknown }[] {
  return ((window as unknown as PostedWindow).__posted ?? []) as { type: string }[];
}

/** All ops the inspector sent, flattened in order. */
export function sentOps(): WorkflowOp[] {
  return posted()
    .filter((m) => m.type === 'ops')
    .flatMap((m) => m.ops as WorkflowOp[]);
}

export function docFor(text: string = REVIEW_LOOP): WorkflowDocumentState {
  const parsed = parseWorkflowText(text);
  const semantic = parsed.workflow ? validateWorkflow(parsed.workflow, { agentIds: AGENTS.map((a) => a.id) }) : [];
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

export function renderInspector(state: Partial<WorkflowUiState> = {}) {
  const initialState: WorkflowUiState = {
    ...initialWorkflowUiState,
    doc: docFor(),
    agents: AGENTS,
    catalog: CATALOG,
    history: RECENT_RUNS.filter((r) => r.workflowName === 'Review until approved'),
    ...state,
  };
  return render(
    <WorkflowStoreProvider initialState={initialState}>
      <Inspector />
    </WorkflowStoreProvider>,
  );
}

/** Delivers a host message to the store, as the extension would. */
export function fromHost(message: HostToWorkflowEditor): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}
