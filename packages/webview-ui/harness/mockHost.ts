/**
 * Browser stand-in for the extension host. It speaks the real protocol and uses the real core
 * (YAML ops, validation, engine) so the harness behaves like VS Code minus the file system and models.
 */
import {
  applyAgentUpdate,
  applyWorkflowOps,
  newAgentText,
  newWorkflowText,
  parseAgentText,
  parseWorkflowText,
  reduceRunEvent,
  runWorkflow,
  validateWorkflow,
  workflowTemplate,
  type ActiveRunSummary,
  type AgentDocumentState,
  type AgentSummary,
  type AgentEditorToHost,
  type ApprovalResult,
  type EngineHost,
  type HostToAgentEditor,
  type HostToSidebar,
  type HostToWorkflowEditor,
  type RunEvent,
  type RunRecordSummary,
  type RunView,
  type SidebarState,
  type SidebarToHost,
  type Workflow,
  type WorkflowDocumentState,
  type WorkflowEditorToHost,
  type WorkflowSummary,
} from '@isar-flow/core';
import {
  AGENTS,
  ALL_BLOCKS_WORKFLOW_TEXT,
  CATALOG,
  FIXTURE_NOW,
  LONG_TEXT_WORKFLOW_TEXT,
  NESTED_WORKFLOW_TEXT,
  RECENT_RUNS,
  REVIEWER_AGENT_TEXT,
  WORKFLOWS,
} from './fixtures';

type Send<T> = (message: T) => void;

/** The documents as the mock host holds them, for scripted checks (scripts/interactions.mjs). */
export const probe: { workflowText?: () => string; agentText?: () => string } = {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function markReady(): void {
  setTimeout(() => {
    document.body.dataset.harnessReady = 'true';
  }, 250);
}

/* ---------------- workflow editor ---------------- */

const WORKFLOW_URI = 'file:///c%3A/work/shop/.isarflow/workflows/review-loop.workflow.yaml';

function scenarioWorkflowText(scenario: string): string {
  const review = workflowTemplate('review-loop', 'Review until approved');
  switch (scenario) {
    case 'empty':
      return newWorkflowText('New workflow');
    case 'allblocks':
      return ALL_BLOCKS_WORKFLOW_TEXT;
    case 'long':
    case 'long-narrow':
      return LONG_TEXT_WORKFLOW_TEXT;
    case 'nested':
    case 'nested-narrow':
      return NESTED_WORKFLOW_TEXT;
    case 'invalid':
      return review.replace('prompt:', 'promt:');
    case 'syntax':
      return review.replace('steps:\n', 'steps:\n   broken: [\n');
    // Hand-written blocks often lack ids; nothing refers to these two, so only the ids are missing.
    case 'noids':
      return review.replace('  - id: implement\n    type: agent', '  - type: agent').replace('- id: fix\n            type: agent', '- type: agent');
    // 'approval' shows a run waiting at the approval; 'approval-live' starts without a run.
    case 'approval':
    case 'approval-live': {
      const parsed = parseWorkflowText(review).workflow as Workflow;
      const result = applyWorkflowOps(review, [
        {
          op: 'insertStep',
          target: { parentId: null, slot: 'steps', index: parsed.steps.length },
          step: { id: 'ship_it', type: 'approval', message: 'Merge the reviewed changes into main?' },
        },
      ]);
      return result.text;
    }
    default:
      return review;
  }
}

interface FakeHostOptions {
  failTests?: boolean;
  delayMs?: number;
  approval?: (stepId: string, message: string) => Promise<ApprovalResult>;
}

/** Scripted host: tests fail once, the reviewer approves on the second round. */
function createFakeHost(options: FakeHostOptions = {}): EngineHost {
  const calls = new Map<string, number>();
  const count = (id: string) => {
    const n = (calls.get(id) ?? 0) + 1;
    calls.set(id, n);
    return n;
  };
  const pause = async (signal: AbortSignal) => {
    if (!options.delayMs) return;
    await sleep(options.delayMs * (0.6 + Math.random() * 0.8));
    if (signal.aborted) throw new Error('Cancelled');
  };
  return {
    async runConsole(req, io) {
      const n = count(req.stepId);
      const failing = options.failTests || n === 1;
      const lines = failing
        ? ['> shop@1.4.0 test', '> vitest run', '', ' ✓ src/cart.test.ts (12 tests)', ' ✗ src/checkout.test.ts > applies the voucher once', '   AssertionError: expected 18.9 to be 19.9', '', ' Tests  1 failed | 31 passed (32)']
        : ['> shop@1.4.0 test', '> vitest run', '', ' ✓ src/cart.test.ts (12 tests)', ' ✓ src/checkout.test.ts (20 tests)', '', ' Tests  32 passed (32)'];
      for (const line of lines) {
        io.log(failing && line.includes('✗') ? 'stderr' : 'stdout', `${line}\n`);
        await pause(io.signal);
      }
      const output = lines.join('\n') + '\n';
      return { exitCode: failing ? 1 : 0, stdout: output, stderr: '', output, timedOut: false };
    },
    async runAgent(req, io) {
      const n = count(req.stepId);
      await pause(io.signal);
      if (req.output?.format === 'json') {
        const approved = n >= 2;
        const json = approved
          ? { approved: true, issues: [] }
          : { approved: false, issues: ['Voucher is applied twice when the cart is re-validated', 'Missing test for expired vouchers'] };
        const text = JSON.stringify(json, null, 2);
        io.log('agent', text);
        return { text, json, model: req.agent.model, usage: { inputTokens: 5200, outputTokens: 310 }, turns: 2, messages: [] };
      }
      const text =
        req.stepId === 'implement'
          ? 'Added voucher support to the checkout: `applyVoucher()` in src/checkout.ts, a `vouchers` table migration and 6 new tests.'
          : 'Fixed the double application by memoising the voucher total and added a test for expired vouchers.';
      io.log('tool', 'readFile src/checkout.ts → 214 lines\n');
      await pause(io.signal);
      io.log('tool', 'editFile src/checkout.ts → replaced 1 occurrence\n');
      for (const word of text.split(' ')) {
        io.log('agent', word + ' ');
        if (options.delayMs) await sleep(25);
      }
      return { text, model: req.agent.model, usage: { inputTokens: 18_400, outputTokens: 1_250 }, turns: 4, messages: [] };
    },
    async requestApproval(req) {
      return options.approval ? options.approval(req.stepId, req.message) : { approved: true };
    },
  };
}

function harnessAgents() {
  const definitions: Record<string, { name: string; model: string }> = {};
  for (const a of AGENTS) definitions[a.id] = { name: a.name, model: a.model };
  return definitions;
}

interface CollectOptions {
  runId?: string;
  /** Start of the scripted clock (1.7 s per event). Runs with `onEvent` are live and use the real clock. */
  startedAt?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

async function collectEvents(
  workflow: Workflow,
  host: EngineHost,
  { runId = 'run-live', startedAt = Date.UTC(2026, 9, 26, 9, 26), signal, onEvent }: CollectOptions = {},
) {
  let clock = startedAt;
  const events: RunEvent[] = [];
  const generator = runWorkflow(workflow, {
    runId,
    inputs: { task: 'Add voucher codes to the checkout' },
    host,
    agents: harnessAgents(),
    workspaceRoot: 'C:/work/shop',
    signal,
    now: onEvent ? undefined : () => (clock += 1700),
  });
  for (;;) {
    const next = await generator.next();
    if (next.done) break;
    events.push(next.value);
    onEvent?.(next.value);
  }
  return events;
}

function viewOf(events: RunEvent[]): RunView | null {
  return events.reduce<RunView | null>((view, event) => reduceRunEvent(view, event), null);
}

/** A finished run as the host keeps it: the summary for the history list and the view to show it again. */
interface PastRun {
  summary: RunRecordSummary;
  view: RunView;
}

function pastRun(view: RunView): PastRun {
  const { runId, workflowName, status, startedAt, durationMs, error, usage } = view;
  return { summary: { runId, workflowUri: WORKFLOW_URI, workflowName, status, startedAt, durationMs, error, usage }, view };
}

/** Runs of the review workflow from before the harness opened: a success minutes ago, a failure two days ago. */
async function seedHistory(): Promise<PastRun[]> {
  const workflow = parseWorkflowText(scenarioWorkflowText('default')).workflow;
  if (!workflow) return [];
  const success = await collectEvents(workflow, createFakeHost(), { runId: 'run-7', startedAt: FIXTURE_NOW - 4 * 60_000 });
  const failure = await collectEvents(workflow, createFakeHost({ failTests: true }), {
    runId: 'run-3',
    startedAt: FIXTURE_NOW - 2 * 86_400_000,
  });
  return [viewOf(success), viewOf(failure)].filter((view): view is RunView => view !== null).map(pastRun);
}

export function workflowHost(scenario: string, send: Send<HostToWorkflowEditor>) {
  let text = scenarioWorkflowText(scenario);
  probe.workflowText = () => text;
  let controller: AbortController | undefined;
  let liveView: RunView | null = null;
  /** Finished runs, newest first; `selectRun` shows them again. */
  let history: PastRun[] = [];
  const sendHistory = () => send({ type: 'history', runs: history.map((run) => run.summary) });
  const pendingApprovals = new Map<string, (result: ApprovalResult) => void>();

  const doc = (source = text): WorkflowDocumentState => {
    const parsed = parseWorkflowText(source);
    const semantic = parsed.workflow
      ? validateWorkflow(parsed.workflow, { agentIds: AGENTS.map((a) => a.id), modelRefs: CATALOG.models.map((m) => m.ref) })
      : [];
    const diagnostics = [...parsed.diagnostics, ...semantic];
    return {
      uri: WORKFLOW_URI,
      fileName: 'review-loop.workflow.yaml',
      text: source,
      workflow: parsed.workflow,
      valid: parsed.valid && !diagnostics.some((d) => d.severity === 'error'),
      diagnostics,
    };
  };

  const prepareScenario = async () => {
    const workflow = parseWorkflowText(text).workflow;
    if (!workflow) return;
    if (scenario === 'running') {
      const events = await collectEvents(workflow, createFakeHost());
      const cut = events.findIndex((e, i) => e.type === 'step-start' && e.stepId === 'review' && events.slice(0, i).some((p) => p.type === 'loop-iteration' && p.iteration === 2));
      send({ type: 'run', run: viewOf(events.slice(0, cut + 1)), live: true });
      send({ type: 'focusStep', stepId: 'tests' });
    } else if (scenario === 'failed') {
      const events = await collectEvents(workflow, createFakeHost({ failTests: true }));
      send({ type: 'run', run: viewOf(events), live: true });
      send({ type: 'focusStep', stepId: 'tests' });
    } else if (scenario === 'approval') {
      const events = await collectEvents(workflow, createFakeHost());
      const cut = events.findIndex((e) => e.type === 'step-start' && e.stepId === 'ship_it');
      send({ type: 'run', run: viewOf(events.slice(0, cut + 1)), live: true });
      send({
        type: 'approvalRequest',
        prompt: { requestId: 'approval-1', runId: 'run-live', stepId: 'ship_it', message: 'Merge the reviewed changes into main?' },
      });
    } else if (scenario === 'history') {
      // A past failed run picked from the history: shown read-only, with its summary in the inspector.
      const failed = history.find((run) => run.summary.status === 'failure');
      if (failed) send({ type: 'run', run: failed.view, live: false });
    } else if (scenario === 'selected') {
      send({ type: 'focusStep', stepId: 'review' });
    } else if (scenario === 'condition') {
      const loop = workflow.steps.find((s) => s.type === 'loop');
      const target = loop?.type === 'loop' ? (loop.steps.find((s) => s.type === 'if')?.id ?? loop.id) : workflow.steps[0]?.id;
      if (target) send({ type: 'focusStep', stepId: target });
    }
  };

  const startRun = async (inputs: Record<string, unknown>) => {
    const workflow = parseWorkflowText(text).workflow;
    if (!workflow) return;
    controller = new AbortController();
    liveView = null;
    const runId = `run-${Date.now().toString(36)}`;
    const host = createFakeHost({
      delayMs: 350,
      approval: (stepId, message) =>
        new Promise<ApprovalResult>((resolve) => {
          const requestId = `approval-${Math.random().toString(36).slice(2)}`;
          pendingApprovals.set(requestId, resolve);
          send({ type: 'approvalRequest', prompt: { requestId, runId, stepId, message } });
        }),
    });
    void inputs;
    await collectEvents(workflow, host, {
      runId,
      signal: controller.signal,
      onEvent: (event) => {
        liveView = reduceRunEvent(liveView, event);
        send({ type: 'runEvent', event });
      },
    });
    const finished: RunView | null = liveView;
    if (finished) {
      history = [pastRun(finished), ...history];
      sendHistory();
    }
  };

  return (message: WorkflowEditorToHost) => {
    switch (message.type) {
      case 'ready':
        // 'syntax': the file was readable before the last keystroke, so the canvas keeps the last valid model.
        if (scenario === 'syntax') send({ type: 'document', doc: doc(scenarioWorkflowText('default')) });
        send({ type: 'document', doc: doc() });
        send({ type: 'catalog', agents: AGENTS, catalog: CATALOG });
        send({ type: 'trust', trusted: scenario !== 'untrusted' });
        void (async () => {
          history = await seedHistory();
          sendHistory();
          await prepareScenario();
          markReady();
        })();
        break;
      case 'ops': {
        const result = applyWorkflowOps(text, message.ops);
        if (result.error) send({ type: 'opsFailed', error: result.error });
        else {
          text = result.text;
          send({ type: 'document', doc: doc() });
        }
        break;
      }
      case 'run':
        void startRun(message.inputs);
        break;
      case 'cancelRun':
        controller?.abort();
        break;
      case 'approval': {
        pendingApprovals.get(message.requestId)?.({ approved: message.approved, comment: message.comment });
        pendingApprovals.delete(message.requestId);
        send({ type: 'approvalResolved', requestId: message.requestId });
        break;
      }
      case 'selectRun': {
        if (message.runId === null) {
          send({ type: 'run', run: liveView, live: true });
          break;
        }
        const past = history.find((run) => run.summary.runId === message.runId);
        send({ type: 'run', run: past?.view ?? null, live: false });
        break;
      }
      default:
        console.info('[mock host] workflow message', message);
    }
  };
}

/* ---------------- sidebar ---------------- */

/** Names, ids and paths at the edge of what people write, to check ellipses and wrapping (token "long"). */
const LONG_AGENT: AgentSummary = {
  id: 'security-and-dependency-upgrade-reviewer',
  name: 'Security and dependency upgrade reviewer for payments',
  model: 'litellm/anthropic.claude-sonnet-4-20250514-v1:0-eu-central-1',
  tools: ['readFile', 'listFiles', 'searchText', 'gitDiff', 'runCommand'],
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
  if (sidebarHas(scenario, 'newagent')) return { agentDraft: { name: 'Test fixer', starter: 'coder', scope: 'workspace' } };
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
  const state: SidebarState = {
    hasWorkspace: !has('noworkspace'),
    trusted: !has('untrusted'),
    agents: empty
      ? []
      : messy
        ? [
            ...AGENTS,
            { id: 'translator', name: '', model: '', tools: [], scope: 'workspace', uri: 'file:///c%3A/work/shop/.isarflow/agents/translator.agent.yaml', valid: false },
            { ...AGENTS[1], scope: 'user', shadowed: true, uri: 'file:///c%3A/Users/me/agents/reviewer.agent.yaml' },
          ]
        : has('long')
          ? [LONG_AGENT, ...AGENTS]
          : [...AGENTS],
    workflows: empty ? [] : has('long') ? [LONG_WORKFLOW, ...WORKFLOWS] : messy ? [...WORKFLOWS, { uri: 'file:///c%3A/work/shop/broken.workflow.yaml', name: '', relativePath: 'broken.workflow.yaml', valid: false, stepCount: 0 }] : [...WORKFLOWS],
    catalog: messy
      ? {
          ...CATALOG,
          loading: true,
          providers: [
            { ...CATALOG.providers[0], status: 'loading' },
            ...CATALOG.providers.slice(1),
            { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: false, status: 'unknown', modelCount: 0 },
          ],
        }
      : CATALOG,
    recentRuns: empty
      ? []
      : has('long')
        ? [{ ...RECENT_RUNS[1], runId: 'run-long', workflowUri: LONG_WORKFLOW.uri, workflowName: LONG_WORKFLOW.name }, ...RECENT_RUNS]
        : RECENT_RUNS,
    activeRuns: running ? [running] : [],
    tab: ['workflows', 'untrusted', 'running', 'newworkflow'].some(has) ? 'workflows' : 'agents',
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
        const tools = AGENTS.find((a) => a.id === message.starter)?.tools ?? ['readFile', 'listFiles', 'searchText'];
        state.agents = [
          ...state.agents,
          { id, name: message.name, model: 'vscode/copilot/gpt-4.1', tools, scope: message.scope, uri: `file:///${id}.agent.yaml`, valid: true },
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
        state.catalog = { ...state.catalog, providers: state.catalog.providers.filter((p) => p.id !== message.providerId) };
        push();
        break;
      case 'createWorkflow':
        state.workflows = [
          ...state.workflows,
          { uri: `file:///${message.name}.workflow.yaml`, name: message.name, relativePath: `.isarflow/workflows/${message.name}.workflow.yaml`, valid: true, stepCount: 0 },
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
      default:
        console.info('[mock host] sidebar message', message);
    }
  };
}

/* ---------------- agent editor ---------------- */

export function agentHost(scenario: string, send: Send<HostToAgentEditor>) {
  let text =
    scenario === 'new'
      ? newAgentText('Translator')
      : scenario === 'invalid'
        ? REVIEWER_AGENT_TEXT.replace('temperature: 0.2', 'temperature: 3').replace('edits: none', 'edits: sometimes')
        : scenario === 'noperms'
          ? // Tools that need permissions, but no levels set: the editor shows the effective "Ask".
            REVIEWER_AGENT_TEXT.replace('gitDiff]', 'gitDiff, editFile, runCommand]').replace(/permissions:\n( {2}.*\n)+/, '')
          : scenario === 'long'
            ? REVIEWER_AGENT_TEXT.replace('name: Reviewer', 'name: Security and dependency upgrade reviewer for payments')
                .replace('description: Strict senior code reviewer', 'description: Checks every dependency bump for breaking changes, licence problems and known vulnerabilities before it is merged')
                .replace('model: vscode/copilot/gpt-4.1', 'model: litellm/anthropic.claude-sonnet-4-20250514-v1:0-eu-central-1')
                .replace('  - litellm/claude-sonnet', '  - litellm/claude-sonnet\n  - openrouter/meta-llama/llama-3.3-70b-instruct:free\n  - ollama/qwen2.5-coder:32b')
            : REVIEWER_AGENT_TEXT;
  const id = scenario === 'new' ? 'translator' : scenario === 'long' ? 'security-and-dependency-upgrade-reviewer' : 'reviewer';
  const usedBy =
    scenario === 'long'
      ? ['.isarflow/workflows/nightly/upgrade-dependencies-and-fix-everything.workflow.yaml', '.isarflow/workflows/review-loop.workflow.yaml']
      : id === 'reviewer'
        ? ['.isarflow/workflows/review-loop.workflow.yaml']
        : [];
  probe.agentText = () => text;
  let streaming: { cancelled: boolean } | undefined;

  const doc = (): AgentDocumentState => {
    const parsed = parseAgentText(text);
    return {
      uri: `file:///c%3A/work/shop/.isarflow/agents/${id}.agent.yaml`,
      id,
      scope: 'workspace',
      fileName: `${id}.agent.yaml`,
      text,
      agent: parsed.agent,
      valid: parsed.valid,
      diagnostics: parsed.diagnostics,
      usedBy,
    };
  };

  const answer = async (prompt: string) => {
    const run = { cancelled: false };
    streaming = run;
    send({ type: 'tryItEvent', event: { type: 'tool', name: 'gitDiff', args: '{}', result: '3 files changed, 48 insertions(+), 6 deletions(-)' } });
    await sleep(300);
    const reply = `{\n  "approved": false,\n  "issues": [\n    "applyVoucher() runs twice when the cart is re-validated",\n    "No test covers expired vouchers"\n  ]\n}`;
    for (const chunk of reply.match(/.{1,6}/gs) ?? []) {
      if (run.cancelled) return;
      send({ type: 'tryItEvent', event: { type: 'text', text: chunk } });
      await sleep(20);
    }
    void prompt;
    send({ type: 'tryItEvent', event: { type: 'done', usage: { inputTokens: 4210, outputTokens: 96 }, model: 'vscode/copilot/gpt-4.1' } });
  };

  return (message: AgentEditorToHost) => {
    switch (message.type) {
      case 'ready':
        send({ type: 'document', doc: doc() });
        send({ type: 'catalog', catalog: CATALOG });
        markReady();
        break;
      case 'update': {
        const result = applyAgentUpdate(text, message.set as Record<string, unknown>, message.unset);
        if (result.error) send({ type: 'updateFailed', error: result.error });
        else {
          text = result.text;
          send({ type: 'document', doc: doc() });
        }
        break;
      }
      case 'tryIt':
        void answer(message.prompt);
        break;
      case 'cancelTryIt':
        if (streaming) streaming.cancelled = true;
        break;
      default:
        console.info('[mock host] agent message', message);
    }
  };
}
