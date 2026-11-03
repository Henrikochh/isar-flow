/**
 * State of the workflow editor webview. The host owns the document; the webview renders the latest
 * `document` message plus the edits it sent and the host has not confirmed yet (see optimistic.ts), and sends
 * semantic ops back. Run state is reduced locally from run events.
 */
import { createContext, type ReactNode, useContext, useMemo, useReducer, useRef } from 'react';
import {
  applyWorkflowOps,
  collectStepIds,
  parseWorkflowText,
  reduceRunEvent,
  validateWorkflow,
  type AgentSummary,
  type ApprovalPrompt,
  type AskPrompt,
  type HostToWorkflowEditor,
  type ModelCatalog,
  type RunRecordSummary,
  type RunReportAction,
  type RunReview,
  type RunView,
  type Workflow,
  type WorkflowDocumentState,
  type WorkflowEditorToHost,
  type WorkflowOp,
  type WorkflowTriggerState,
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
  /** Ask blocks waiting for an answer, oldest first. */
  asks: AskPrompt[];
  /** The workflow's triggers and whether they start runs; null until the host sends them. */
  triggers: WorkflowTriggerState | null;
  /** Selected block id. */
  selection: string | null;
  /** Last ops error from the host, shown as a dismissible banner. */
  opsError: string | null;
  /** Files the shown run changed and the decisions about them; null when it changed none. */
  review: RunReview | null;
  /** A review that arrived before its run; shown once that run is shown. */
  parkedReview?: RunReview | null;
  /**
   * Most recent non-null workflow model. While the YAML has a syntax error (`doc.workflow` is null) the canvas
   * keeps rendering this one, dimmed.
   */
  lastWorkflow?: Workflow | null;
  /** "Run from here" waiting for its run to be shown, then for the user's answer (RunFromHereHost). */
  resumeRequest?: ResumeRequest | null;
  /** Run or Simulate asked for outside the top bar (a banner); the top bar asks for inputs and starts it. */
  startRequest?: StartMode | null;
}

export type StartMode = 'run' | 'simulate';

export interface ResumeRequest {
  runId: string;
  stepId: string;
}

export type WorkflowUiAction =
  | HostToWorkflowEditor
  | { type: 'select'; stepId: string | null }
  | { type: 'dismissOpsError' }
  /** Ops the webview just sent to the host; shown at once. */
  | { type: 'localOps'; ops: WorkflowOp[] }
  | ({ type: 'requestResume' } & ResumeRequest)
  | { type: 'clearResumeRequest' }
  | { type: 'requestStart'; mode: StartMode }
  | { type: 'clearStartRequest' };

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
  asks: [],
  triggers: null,
  selection: null,
  opsError: null,
  review: null,
  resumeRequest: null,
  startRequest: null,
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
    case 'run': {
      const runId = action.run?.runId;
      const review = [state.review, state.parkedReview].find((r) => r && r.runId === runId) ?? null;
      // No run means the requested one is gone (pruned); any other run may be shown before it.
      const resumeRequest = action.run ? state.resumeRequest : null;
      return { ...state, run: action.run, runLive: action.live, review, parkedReview: null, resumeRequest };
    }
    case 'runEvent': {
      // While a past run is shown, live events are ignored; the host sends a 'run' snapshot when switching back.
      if (state.run && !state.runLive && action.event.type !== 'run-start') return state;
      const start = action.event.type === 'run-start';
      const run = reduceRunEvent(start ? null : state.run, action.event);
      return start
        ? { ...state, run, runLive: true, review: null, parkedReview: null, resumeRequest: null }
        : { ...state, run, runLive: true };
    }
    case 'review': {
      const review = action.review;
      if (!review) return { ...state, review: null, parkedReview: null };
      return review.runId === state.run?.runId
        ? { ...state, review, parkedReview: null }
        : { ...state, parkedReview: review };
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
    case 'askRequest':
      return {
        ...state,
        asks: [...state.asks.filter((a) => a.requestId !== action.prompt.requestId), action.prompt],
      };
    case 'askResolved':
      return { ...state, asks: state.asks.filter((a) => a.requestId !== action.requestId) };
    case 'triggers':
      return { ...state, triggers: action.triggers };
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
    case 'requestResume':
      return { ...state, resumeRequest: { runId: action.runId, stepId: action.stepId } };
    case 'clearResumeRequest':
      return { ...state, resumeRequest: null };
    case 'requestStart':
      return { ...state, startRequest: action.mode };
    case 'clearStartRequest':
      return { ...state, startRequest: null };
    default:
      return state;
  }
}

export interface WorkflowActions {
  applyOps(ops: WorkflowOp[]): void;
  select(stepId: string | null): void;
  run(inputs: Record<string, unknown>): void;
  /** Continues the finished run `runId` at block `stepId`. */
  runFromHere(runId: string, stepId: string, inputs: Record<string, unknown>): void;
  simulate(inputs: Record<string, unknown>): void;
  openSimulationFile(): void;
  /** Starts "Run from here"; shows that run first when another one is shown (RunFromHereHost takes over). */
  requestResume(runId: string, stepId: string): void;
  clearResumeRequest(): void;
  /** Run or Simulate like the top bar does (inputs dialog first); for buttons outside the top bar. */
  requestStart(mode: StartMode): void;
  clearStartRequest(): void;
  cancelRun(): void;
  selectRun(runId: string | null): void;
  answerApproval(requestId: string, approved: boolean, comment?: string): void;
  /** Answers an ask block; its card goes away at once. */
  answerAsk(requestId: string, answer: string): void;
  /** Export report or Copy for PR description of a finished run. */
  runReport(runId: string, action: RunReportAction): void;
  /** Opens the VS Code settings filtered by `query`. */
  openSettings(query: string): void;
  /** Turns triggers on again after they were paused for starting too often. */
  resumeTriggers(): void;
  /** Keeps or reverts files of a run's review; without paths every pending file. */
  reviewFiles(runId: string, decision: 'kept' | 'reverted', paths?: string[]): void;
  openReviewDiff(runId: string, path: string): void;
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
  const shownRunId = useRef<string | undefined>(undefined);
  shownRunId.current = state.run?.runId;

  const actions = useMemo<WorkflowActions>(
    () => ({
      applyOps: (ops) => {
        if (!ops.length) return;
        send({ type: 'ops', ops });
        dispatch({ type: 'localOps', ops });
      },
      select: (stepId) => dispatch({ type: 'select', stepId }),
      run: (inputs) => send({ type: 'run', inputs }),
      runFromHere: (runId, stepId, inputs) => send({ type: 'runFromHere', runId, stepId, inputs }),
      simulate: (inputs) => send({ type: 'simulate', inputs }),
      openSimulationFile: () => send({ type: 'openSimulationFile' }),
      requestResume: (runId, stepId) => {
        dispatch({ type: 'requestResume', runId, stepId });
        if (shownRunId.current !== runId) send({ type: 'selectRun', runId });
      },
      clearResumeRequest: () => dispatch({ type: 'clearResumeRequest' }),
      requestStart: (mode) => dispatch({ type: 'requestStart', mode }),
      clearStartRequest: () => dispatch({ type: 'clearStartRequest' }),
      cancelRun: () => send({ type: 'cancelRun' }),
      selectRun: (runId) => send({ type: 'selectRun', runId }),
      answerApproval: (requestId, approved, comment) =>
        send({ type: 'approval', requestId, approved, comment }),
      answerAsk: (requestId, answer) => {
        send({ type: 'answer', requestId, answer });
        dispatch({ type: 'askResolved', requestId });
      },
      runReport: (runId, action) => send({ type: 'runReport', runId, action }),
      openSettings: (query) => send({ type: 'openSettings', query }),
      resumeTriggers: () => send({ type: 'resumeTriggers' }),
      reviewFiles: (runId, decision, paths) =>
        send(
          paths ? { type: 'reviewFiles', runId, decision, paths } : { type: 'reviewFiles', runId, decision },
        ),
      openReviewDiff: (runId, path) => send({ type: 'openReviewDiff', runId, path }),
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
