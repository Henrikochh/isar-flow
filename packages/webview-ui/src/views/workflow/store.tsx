/**
 * State of the workflow editor webview. The host owns the document; the webview renders the latest
 * `document` message plus the edits it sent and the host has not confirmed yet (see optimistic.ts), and sends
 * semantic ops back. Run state is reduced locally from run events.
 */
import { createContext, type ReactNode, useContext, useMemo, useReducer } from 'react';
import {
  applyWorkflowOps,
  collectStepIds,
  parseWorkflowText,
  reduceRunEvent,
  validateWorkflow,
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
import { reconcilePending } from '../../optimistic';
import { post, useHostMessages } from '../../vscode';

export interface WorkflowUiState {
  /** The shown document: the host's, with the edits it has not confirmed yet applied. */
  doc: WorkflowDocumentState | null;
  /** The last document the host sent. */
  hostDoc?: WorkflowDocumentState | null;
  /** Texts the sent, unconfirmed edits produce, oldest first. */
  pending: string[];
  /** New ids of unconfirmed renames, mapped to the ids before them, to restore the selection on failure. */
  renamedFrom?: Record<string, string>;
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
  | HostToWorkflowEditor
  | { type: 'select'; stepId: string | null }
  | { type: 'dismissOpsError' }
  /** Ops the webview just sent to the host; shown at once. */
  | { type: 'localOps'; ops: WorkflowOp[] };

export const initialWorkflowUiState: WorkflowUiState = {
  doc: null,
  pending: [],
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

/** The document the host will send for `text`, parsed and validated the way the host does it. */
function documentFor(
  base: WorkflowDocumentState,
  text: string,
  state: WorkflowUiState,
): WorkflowDocumentState {
  const parsed = parseWorkflowText(text);
  // Until the agents arrive an agent id is not known to be wrong; while models load they are not checked.
  const semantic = parsed.workflow
    ? validateWorkflow(parsed.workflow, {
        agentIds: state.agents.length ? [...new Set(state.agents.map((a) => a.id))] : undefined,
        modelRefs: state.catalog.loading ? [] : state.catalog.models.map((m) => m.ref),
      })
    : [];
  const diagnostics = [...parsed.diagnostics, ...semantic];
  const valid = parsed.valid && !diagnostics.some((d) => d.severity === 'error');
  return { ...base, text, workflow: parsed.workflow, valid, diagnostics };
}

function showDocument(state: WorkflowUiState, doc: WorkflowDocumentState): WorkflowUiState {
  const workflow = doc.workflow;
  // While the YAML cannot be read there is no model to check the selection against, so it is kept.
  if (!workflow) return { ...state, doc };
  // collectStepIds tolerates the lenient model (blocks without ids, odd nesting).
  const selection =
    state.selection && collectStepIds(workflow).includes(state.selection) ? state.selection : null;
  return { ...state, doc, selection, lastWorkflow: workflow };
}

/** The selected id as the host document knows it, following unconfirmed renames back. */
function selectionBeforeRenames(state: WorkflowUiState, host: WorkflowDocumentState | null): string | null {
  const ids = host?.workflow ? collectStepIds(host.workflow) : [];
  let selection = state.selection;
  const seen = new Set<string>();
  while (selection && !ids.includes(selection) && state.renamedFrom?.[selection] && !seen.has(selection)) {
    seen.add(selection);
    selection = state.renamedFrom[selection];
  }
  return selection;
}

export function workflowUiReducer(state: WorkflowUiState, action: WorkflowUiAction): WorkflowUiState {
  switch (action.type) {
    case 'document': {
      const pending = reconcilePending(state.pending, (state.hostDoc ?? state.doc)?.text, action.doc.text);
      const renamedFrom = pending.length > 0 ? state.renamedFrom : undefined;
      const next = { ...state, hostDoc: action.doc, pending, renamedFrom };
      const latest = pending[pending.length - 1];
      return showDocument(next, latest === undefined ? action.doc : documentFor(action.doc, latest, next));
    }
    case 'localOps': {
      const current = state.doc;
      if (!current?.workflow) return state;
      const result = applyWorkflowOps(current.text, action.ops);
      // The host reports edits it cannot apply (opsFailed); there is nothing to show before that.
      if (result.error !== undefined || result.text === current.text) return state;
      const renamedFrom = { ...state.renamedFrom };
      for (const op of action.ops) if (op.op === 'renameStep') renamedFrom[op.newId] = op.stepId;
      const next = {
        ...state,
        hostDoc: state.hostDoc ?? current,
        pending: [...state.pending, result.text],
        renamedFrom,
      };
      return showDocument(next, documentFor(current, result.text, next));
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
    case 'opsFailed': {
      // The edits after the failed one were planned on it; show what the host has.
      const host = state.hostDoc ?? state.doc;
      const selection = selectionBeforeRenames(state, host);
      const next = { ...state, opsError: action.error, pending: [], renamedFrom: undefined, selection };
      return host ? showDocument(next, host) : next;
    }
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
        if (!ops.length) return;
        send({ type: 'ops', ops });
        dispatch({ type: 'localOps', ops });
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
