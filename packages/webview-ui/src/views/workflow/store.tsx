/**
 * State of the workflow editor webview. The host owns the document; the webview renders the latest
 * `document` message and sends semantic ops back. Run state is reduced locally from run events.
 */
import { createContext, type ReactNode, useContext, useMemo, useReducer } from 'react';
import {
  collectStepIds,
  reduceRunEvent,
  type AgentSummary,
  type ApprovalPrompt,
  type HostToWorkflowEditor,
  type ModelCatalog,
  type RunRecordSummary,
  type RunView,
  type Workflow,
  type WorkflowDocumentState,
  type WorkflowEditorToHost,
  type WorkflowOp,
} from '@isar-flow/core';
import { post, useHostMessages } from '../../vscode';

export interface WorkflowUiState {
  doc: WorkflowDocumentState | null;
  agents: AgentSummary[];
  catalog: ModelCatalog;
  trusted: boolean;
  /** Run shown on the canvas (live or from history). */
  run: RunView | null;
  /** True when `run` is the live run of this workflow. */
  runLive: boolean;
  history: RunRecordSummary[];
  approvals: ApprovalPrompt[];
  /** Selected block id. */
  selection: string | null;
  /** Last ops error from the host, shown as a dismissible banner. */
  opsError: string | null;
  /**
   * Most recent non-null workflow model. While the YAML has a syntax error (`doc.workflow` is null) the canvas
   * keeps rendering this one, dimmed.
   */
  lastWorkflow?: Workflow | null;
}

export type WorkflowUiAction =
  HostToWorkflowEditor | { type: 'select'; stepId: string | null } | { type: 'dismissOpsError' };

export const initialWorkflowUiState: WorkflowUiState = {
  doc: null,
  agents: [],
  catalog: { models: [], providers: [], loading: true },
  trusted: true,
  run: null,
  runLive: false,
  history: [],
  approvals: [],
  selection: null,
  opsError: null,
};

export function workflowUiReducer(state: WorkflowUiState, action: WorkflowUiAction): WorkflowUiState {
  switch (action.type) {
    case 'document': {
      const workflow = action.doc.workflow;
      // While the YAML cannot be read there is no model to check the selection against, so it is kept.
      if (!workflow) return { ...state, doc: action.doc };
      // collectStepIds tolerates the lenient model (blocks without ids, odd nesting).
      const selection =
        state.selection && collectStepIds(workflow).includes(state.selection) ? state.selection : null;
      return { ...state, doc: action.doc, selection, lastWorkflow: workflow };
    }
    case 'catalog':
      return { ...state, agents: action.agents, catalog: action.catalog };
    case 'trust':
      return { ...state, trusted: action.trusted };
    case 'run':
      return { ...state, run: action.run, runLive: action.live };
    case 'runEvent': {
      // While a past run is shown, live events are ignored; the host sends a 'run' snapshot when switching back.
      if (state.run && !state.runLive && action.event.type !== 'run-start') return state;
      const base = action.event.type === 'run-start' ? null : state.run;
      return { ...state, run: reduceRunEvent(base, action.event), runLive: true };
    }
    case 'history':
      return { ...state, history: action.runs };
    case 'approvalRequest':
      return {
        ...state,
        approvals: [...state.approvals.filter((a) => a.requestId !== action.prompt.requestId), action.prompt],
      };
    case 'approvalResolved':
      return { ...state, approvals: state.approvals.filter((a) => a.requestId !== action.requestId) };
    case 'opsFailed':
      return { ...state, opsError: action.error };
    case 'dismissOpsError':
      return { ...state, opsError: null };
    case 'focusStep':
    case 'select':
      return { ...state, selection: action.stepId };
    default:
      return state;
  }
}

export interface WorkflowActions {
  applyOps(ops: WorkflowOp[]): void;
  select(stepId: string | null): void;
  run(inputs: Record<string, unknown>): void;
  cancelRun(): void;
  selectRun(runId: string | null): void;
  answerApproval(requestId: string, approved: boolean, comment?: string): void;
  openYaml(stepId?: string): void;
  openAgent(agentId: string): void;
  createAgent(): void;
  refreshModels(): void;
  copy(text: string): void;
  dismissOpsError(): void;
}

const StateContext = createContext<WorkflowUiState>(initialWorkflowUiState);
const ActionsContext = createContext<WorkflowActions | null>(null);

const send = (message: WorkflowEditorToHost) => post(message);

export function WorkflowStoreProvider({
  children,
  initialState = initialWorkflowUiState,
}: {
  children: ReactNode;
  initialState?: WorkflowUiState;
}) {
  const [state, dispatch] = useReducer(workflowUiReducer, initialState);
  useHostMessages<HostToWorkflowEditor>((message) => dispatch(message));

  const actions = useMemo<WorkflowActions>(
    () => ({
      applyOps: (ops) => {
        if (ops.length) send({ type: 'ops', ops });
      },
      select: (stepId) => dispatch({ type: 'select', stepId }),
      run: (inputs) => send({ type: 'run', inputs }),
      cancelRun: () => send({ type: 'cancelRun' }),
      selectRun: (runId) => send({ type: 'selectRun', runId }),
      answerApproval: (requestId, approved, comment) =>
        send({ type: 'approval', requestId, approved, comment }),
      openYaml: (stepId) => send({ type: 'openYaml', stepId }),
      openAgent: (agentId) => send({ type: 'openAgent', agentId }),
      createAgent: () => send({ type: 'createAgent' }),
      refreshModels: () => send({ type: 'refreshModels' }),
      copy: (text) => send({ type: 'copyToClipboard', text }),
      dismissOpsError: () => dispatch({ type: 'dismissOpsError' }),
    }),
    [],
  );

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  );
}

export function useWorkflowState(): WorkflowUiState {
  return useContext(StateContext);
}

export function useWorkflowActions(): WorkflowActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useWorkflowActions must be used inside WorkflowStoreProvider');
  return actions;
}
