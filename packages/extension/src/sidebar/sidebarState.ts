import type {
  AgentSummary,
  ModelCatalog,
  RunRecordSummary,
  SidebarState,
  SidebarTab,
  WorkflowSummary,
} from '@isar-flow/core';

export const RECENT_RUN_LIMIT = 8;

export interface SidebarStateInput {
  hasWorkspace: boolean;
  trusted: boolean;
  agents: AgentSummary[];
  workflows: WorkflowSummary[];
  catalog: ModelCatalog;
  /** Run history of all workflows. */
  history: RunRecordSummary[];
  activeRuns: { workflowUri: string }[];
  /** Stored tab; unknown values fall back to the agents tab. */
  tab: unknown;
}

export function parseTab(value: unknown): SidebarTab {
  return value === 'workflows' ? 'workflows' : 'agents';
}

export function buildSidebarState(input: SidebarStateInput): SidebarState {
  const recentRuns = [...input.history].sort((a, b) => b.startedAt - a.startedAt).slice(0, RECENT_RUN_LIMIT);
  return {
    hasWorkspace: input.hasWorkspace,
    trusted: input.trusted,
    agents: input.agents,
    workflows: input.workflows,
    catalog: input.catalog,
    recentRuns,
    activeRuns: [...new Set(input.activeRuns.map((run) => run.workflowUri))],
    tab: parseTab(input.tab),
  };
}
