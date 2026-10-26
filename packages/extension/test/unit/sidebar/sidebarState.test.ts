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
const run = (n: number, status: RunRecordSummary['status'] = 'success'): RunRecordSummary => ({
  runId: `r${n}`,
  workflowUri: workflow.uri,
  workflowName: 'A',
  status,
  startedAt: n,
});
const live = (n: number, workflowUri = workflow.uri) => ({
  runId: `live${n}`,
  workflowUri,
  view: { workflowName: `Flow ${n}`, startedAt: 100 + n },
});

const base = {
  hasWorkspace: true,
  trusted: true,
  agents: [],
  workflows: [],
  catalog,
  history: [],
  activeRuns: [],
  tab: undefined,
};

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
      activeRuns: [],
      tab: 'workflows',
    });
    expect(state).toEqual({
      hasWorkspace: true,
      trusted: false,
      agents: [agent],
      workflows: [workflow],
      catalog,
      recentRuns: [11, 10, 9, 8, 7, 6, 5, 4].map((n) => run(n)),
      activeRuns: [],
      tab: 'workflows',
    });
    expect(RECENT_RUN_LIMIT).toBe(8);
  });

  it('keeps an already sorted history as is', () => {
    const history = [run(3), run(2), run(1)];
    const state = buildSidebarState({ ...base, hasWorkspace: false, history });
    expect(state.recentRuns).toEqual(history);
    expect(state.tab).toBe('agents');
  });

  it('lists live runs, newest first, with their workflow name and start time', () => {
    const other = 'file:///ws/b.workflow.yaml';
    const state = buildSidebarState({ ...base, activeRuns: [live(1), live(2, other)] });
    expect(state.activeRuns).toEqual([
      { runId: 'live2', workflowUri: other, workflowName: 'Flow 2', startedAt: 102 },
      { runId: 'live1', workflowUri: workflow.uri, workflowName: 'Flow 1', startedAt: 101 },
    ]);
  });

  it('lists finished runs only as recent runs', () => {
    const history = [
      run(5, 'running'),
      run(4, 'failure'),
      run(3, 'cancelled'),
      { ...run(2), runId: 'live1' },
    ];
    const state = buildSidebarState({ ...base, history, activeRuns: [live(1)] });
    expect(state.recentRuns.map((r) => r.runId)).toEqual(['r4', 'r3']);
    expect(state.activeRuns.map((r) => r.runId)).toEqual(['live1']);
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
