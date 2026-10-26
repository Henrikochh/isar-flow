import type {
  ActiveRunSummary,
  AgentSummary,
  ModelCatalog,
  RunRecordSummary,
  RunView,
  SidebarState,
  SidebarTab,
  WorkflowSummary,
} from '@isar-flow/core';

export const RECENT_RUN_LIMIT = 8;

/** A run in progress, as RunManager.active() reports it. */
export interface LiveRunInput {
  runId: string;
  workflowUri: string;
  view: Pick<RunView, 'workflowName' | 'startedAt'>;
}

export interface SidebarStateInput {
  hasWorkspace: boolean;
  trusted: boolean;
  agents: AgentSummary[];
  workflows: WorkflowSummary[];
  catalog: ModelCatalog;
  /** Run history of all workflows. */
  history: RunRecordSummary[];
  activeRuns: LiveRunInput[];
  /** Stored tab; unknown values fall back to the agents tab. */
  tab: unknown;
}

export function parseTab(value: unknown): SidebarTab {
  return value === 'workflows' ? 'workflows' : 'agents';
}

const newestFirst = (a: { startedAt: number }, b: { startedAt: number }) => b.startedAt - a.startedAt;

export function buildSidebarState(input: SidebarStateInput): SidebarState {
  const live = new Set(input.activeRuns.map((run) => run.runId));
  const recentRuns = input.history
    .filter((run) => run.status !== 'running' && !live.has(run.runId))
    .sort(newestFirst)
    .slice(0, RECENT_RUN_LIMIT);
  const activeRuns = input.activeRuns
    .map(({ runId, workflowUri, view }): ActiveRunSummary => ({
      runId,
      workflowUri,
      workflowName: view.workflowName,
      startedAt: view.startedAt,
    }))
    .sort(newestFirst);
  return {
    hasWorkspace: input.hasWorkspace,
    trusted: input.trusted,
    agents: input.agents,
    workflows: input.workflows,
    catalog: input.catalog,
    recentRuns,
    activeRuns,
    tab: parseTab(input.tab),
  };
}
