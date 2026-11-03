/** Sidebar side of the mock host: agents, workflows, runs, models and the setup check. */
import type {
  ActiveRunSummary,
  AgentSummary,
  HostToSidebar,
  RunRecordSummary,
  SidebarState,
  SidebarToHost,
  WorkflowSummary,
} from '@isar-flow/core';
import {
  AGENTS,
  CATALOG,
  MARKED_RUNS,
  RECENT_RUNS,
  SETUP_REPORT,
  SETUP_REPORT_RUNNING,
  WORKFLOWS,
} from './fixtures';
import { markReady, testModel, type Send } from './mockShared';

/** Names, ids and paths at the edge of what people write, to check ellipses and wrapping (token "long"). */
const LONG_AGENT: AgentSummary = {
  id: 'security-and-dependency-upgrade-reviewer',
  name: 'Security and dependency upgrade reviewer for payments',
  model: 'litellm/anthropic.claude-sonnet-4-20250514-v1:0-eu-central-1',
  tools: ['readFile', 'listFiles', 'searchText', 'gitDiff', 'runCommand'],
  permissions: { edits: 'none', commands: 'ask' },
  scope: 'user',
  uri: 'file:///c%3A/Users/me/agents/security-and-dependency-upgrade-reviewer.agent.yaml',
  valid: true,
};
const LONG_WORKFLOW: WorkflowSummary = {
  uri: 'file:///c%3A/work/shop/.isarflow/workflows/nightly/upgrade-dependencies-and-fix-everything.workflow.yaml',
  name: 'Upgrade all dependencies, run the full test matrix and fix what breaks',
  relativePath: '.isarflow/workflows/nightly/upgrade-dependencies-and-fix-everything.workflow.yaml',
  valid: true,
  stepCount: 9,
};

/** Sidebar scenarios combine tokens, e.g. "narrow-workflows" or "wide-running". */
const sidebarHas = (scenario: string, token: string) => scenario.split('-').includes(token);

/** Initial webview state for sidebar scenarios that show an open "New …" card. */
export function sidebarViewState(scenario: string): unknown {
  if (sidebarHas(scenario, 'newagent'))
    return { agentDraft: { name: 'Test fixer', starter: 'coder', scope: 'workspace' } };
  if (sidebarHas(scenario, 'newworkflow')) return { workflowDraft: { name: '', template: 'review-loop' } };
  return undefined;
}

export function sidebarHost(scenario: string, send: Send<HostToSidebar>) {
  const has = (token: string) => sidebarHas(scenario, token);
  const empty = has('empty');
  const liveRun = (workflow: WorkflowSummary, startedAt: number): ActiveRunSummary => ({
    runId: `run-live-${startedAt}`,
    workflowUri: workflow.uri,
    workflowName: workflow.name,
    startedAt,
  });
  const running = has('running') ? liveRun(WORKFLOWS[0], Date.now() - 70_000) : undefined;
  // "messy": what a lenient host may send for broken files and half-configured providers.
  const messy = has('messy');
  // "markers": the newest runs are a simulated and a resumed one (Package B).
  const markers = has('markers');
  const lastRunOf = (workflow: WorkflowSummary) =>
    MARKED_RUNS.find((run) => run.workflowUri === workflow.uri) ?? workflow.lastRun;
  const state: SidebarState = {
    hasWorkspace: !has('noworkspace'),
    trusted: !has('untrusted'),
    agents: empty
      ? []
      : messy
        ? [
            ...AGENTS,
            {
              id: 'translator',
              name: '',
              model: '',
              tools: [],
              scope: 'workspace',
              uri: 'file:///c%3A/work/shop/.isarflow/agents/translator.agent.yaml',
              valid: false,
            },
            {
              ...AGENTS[1],
              scope: 'user',
              shadowed: true,
              uri: 'file:///c%3A/Users/me/agents/reviewer.agent.yaml',
            },
          ]
        : has('long')
          ? [LONG_AGENT, ...AGENTS]
          : [...AGENTS],
    workflows: empty
      ? []
      : has('long')
        ? [LONG_WORKFLOW, ...WORKFLOWS]
        : messy
          ? [
              ...WORKFLOWS,
              {
                uri: 'file:///c%3A/work/shop/broken.workflow.yaml',
                name: '',
                relativePath: 'broken.workflow.yaml',
                valid: false,
                stepCount: 0,
              },
            ]
          : markers
            ? WORKFLOWS.map((workflow) => ({ ...workflow, lastRun: lastRunOf(workflow) }))
            : [...WORKFLOWS],
    catalog: messy
      ? {
          ...CATALOG,
          loading: true,
          providers: [
            { ...CATALOG.providers[0], status: 'loading' },
            ...CATALOG.providers.slice(1),
            {
              id: 'openrouter',
              label: 'OpenRouter',
              kind: 'openai-compatible',
              baseUrl: 'https://openrouter.ai/api/v1',
              hasApiKey: false,
              status: 'unknown',
              modelCount: 0,
            },
          ],
        }
      : CATALOG,
    recentRuns: empty
      ? []
      : has('long')
        ? [
            {
              ...RECENT_RUNS[1],
              runId: 'run-long',
              workflowUri: LONG_WORKFLOW.uri,
              workflowName: LONG_WORKFLOW.name,
            },
            ...RECENT_RUNS,
          ]
        : markers
          ? [...MARKED_RUNS, ...RECENT_RUNS]
          : RECENT_RUNS,
    activeRuns: running ? [running] : [],
    tab: ['workflows', 'untrusted', 'running', 'newworkflow'].some(has) ? 'workflows' : 'agents',
    setupCheck: has('setup') ? SETUP_REPORT : has('setuprunning') ? SETUP_REPORT_RUNNING : null,
  };
  const push = () => send({ type: 'state', state: { ...state } });
  const finishRun = (runId: string, status: 'success' | 'cancelled') => {
    const run = state.activeRuns.find((r) => r.runId === runId);
    if (!run) return;
    const record: RunRecordSummary = { ...run, status, durationMs: Date.now() - run.startedAt };
    state.activeRuns = state.activeRuns.filter((r) => r.runId !== runId);
    state.recentRuns = [record, ...state.recentRuns];
    state.workflows = state.workflows.map((w) => (w.uri === run.workflowUri ? { ...w, lastRun: record } : w));
    push();
  };

  return (message: SidebarToHost) => {
    switch (message.type) {
      case 'ready':
        push();
        markReady();
        break;
      case 'setTab':
        state.tab = message.tab;
        push();
        break;
      case 'createAgent': {
        const id = message.name.toLowerCase().replace(/\W+/g, '-');
        // Starters borrow the tools of the matching sample agent; blank agents only read.
        const starter = AGENTS.find((a) => a.id === message.starter);
        const tools = starter?.tools ?? ['readFile', 'listFiles', 'searchText'];
        const permissions = starter?.permissions ?? { edits: 'ask', commands: 'ask' };
        state.agents = [
          ...state.agents,
          {
            id,
            name: message.name,
            model: 'vscode/copilot/gpt-4.1',
            tools,
            permissions,
            scope: message.scope,
            uri: `file:///${id}.agent.yaml`,
            valid: true,
          },
        ];
        push();
        break;
      }
      // Confirmed inline by the webview, so the host acts without asking again.
      case 'deleteAgent':
        state.agents = state.agents.filter((a) => a.uri !== message.uri);
        push();
        break;
      case 'removeProvider':
        state.catalog = {
          ...state.catalog,
          providers: state.catalog.providers.filter((p) => p.id !== message.providerId),
        };
        push();
        break;
      case 'createWorkflow':
        state.workflows = [
          ...state.workflows,
          {
            uri: `file:///${message.name}.workflow.yaml`,
            name: message.name,
            relativePath: `.isarflow/workflows/${message.name}.workflow.yaml`,
            valid: true,
            stepCount: 0,
          },
        ];
        push();
        break;
      case 'runWorkflow': {
        const workflow = state.workflows.find((w) => w.uri === message.uri);
        if (!workflow) break;
        const run = liveRun(workflow, Date.now());
        state.activeRuns = [...state.activeRuns, run];
        push();
        setTimeout(() => finishRun(run.runId, 'success'), 4000);
        break;
      }
      case 'cancelRun':
        finishRun(message.runId, 'cancelled');
        break;
      case 'refreshModels':
        state.catalog = { ...state.catalog, loading: true };
        push();
        setTimeout(() => {
          state.catalog = { ...CATALOG, loading: false };
          push();
        }, 900);
        break;
      case 'checkSetup': {
        const startedAt = Date.now();
        state.setupCheck = { ...SETUP_REPORT_RUNNING, startedAt };
        push();
        setTimeout(() => {
          state.setupCheck = { ...SETUP_REPORT, startedAt, finishedAt: Date.now() };
          push();
        }, 800);
        break;
      }
      case 'dismissSetupCheck':
        state.setupCheck = null;
        push();
        break;
      case 'testModel': {
        const ref = message.ref ?? state.catalog.models.find((m) => m.provider === message.providerId)?.ref;
        if (!ref) break;
        testModel(
          ref,
          () => state.catalog,
          (catalog) => {
            state.catalog = catalog;
            push();
          },
        );
        break;
      }
      case 'openSettings':
        console.info('[mock host] open settings', message.query);
        break;
      default:
        console.info('[mock host] sidebar message', message);
    }
  };
}
