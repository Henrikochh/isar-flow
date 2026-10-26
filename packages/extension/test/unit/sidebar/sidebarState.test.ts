import { describe, expect, it } from 'vitest';
import type { AgentSummary, ModelCatalog, RunRecordSummary, WorkflowSummary } from '@isar-flow/core';
import { buildSidebarState, parseTab, RECENT_RUN_LIMIT } from '../../../src/sidebar/sidebarState';

const agent: AgentSummary = {
  id: 'coder',
  name: 'Coder',
  model: 'vscode/copilot/gpt-4.1',
  tools: ['readFile'],
  scope: 'workspace',
  uri: 'file:///ws/.isarflow/agents/coder.agent.yaml',
  valid: true,
};
const workflow: WorkflowSummary = {
  uri: 'file:///ws/a.workflow.yaml',
  name: 'A',
  relativePath: 'a.workflow.yaml',
  valid: true,
  stepCount: 2,
};
const catalog: ModelCatalog = { models: [], providers: [], loading: true };
const run = (n: number): RunRecordSummary => ({
  runId: `r${n}`,
  workflowUri: workflow.uri,
  workflowName: 'A',
  status: 'success',
  startedAt: n,
});

describe('buildSidebarState', () => {
  it('passes the lists through and keeps the newest runs', () => {
    const history = Array.from({ length: 12 }, (_, i) => run(i));
    const state = buildSidebarState({
      hasWorkspace: true,
      trusted: false,
      agents: [agent],
      workflows: [workflow],
      catalog,
      history,
      activeRuns: [
        { workflowUri: 'file:///ws/a.workflow.yaml' },
        { workflowUri: 'file:///ws/a.workflow.yaml' },
      ],
      tab: 'workflows',
    });
    expect(state).toEqual({
      hasWorkspace: true,
      trusted: false,
      agents: [agent],
      workflows: [workflow],
      catalog,
      recentRuns: [11, 10, 9, 8, 7, 6, 5, 4].map(run),
      activeRuns: ['file:///ws/a.workflow.yaml'],
      tab: 'workflows',
    });
    expect(RECENT_RUN_LIMIT).toBe(8);
  });

  it('keeps an already sorted history as is', () => {
    const history = [run(3), run(2), run(1)];
    const state = buildSidebarState({
      hasWorkspace: false,
      trusted: true,
      agents: [],
      workflows: [],
      catalog,
      history,
      activeRuns: [],
      tab: undefined,
    });
    expect(state.recentRuns).toEqual(history);
    expect(state.tab).toBe('agents');
  });
});

describe('parseTab', () => {
  it('accepts known tabs and falls back to agents', () => {
    expect(parseTab('agents')).toBe('agents');
    expect(parseTab('workflows')).toBe('workflows');
    expect(parseTab('runs')).toBe('agents');
    expect(parseTab(3)).toBe('agents');
  });
});
