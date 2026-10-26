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
  type AgentDocumentState,
  type AgentEditorToHost,
  type ApprovalResult,
  type EngineHost,
  type HostToAgentEditor,
  type HostToSidebar,
  type HostToWorkflowEditor,
  type RunEvent,
  type RunView,
  type SidebarState,
  type SidebarToHost,
  type Workflow,
  type WorkflowDocumentState,
  type WorkflowEditorToHost,
} from '@isar-flow/core';
import {
  AGENTS,
  ALL_BLOCKS_WORKFLOW_TEXT,
  CATALOG,
  LONG_TEXT_WORKFLOW_TEXT,
  RECENT_RUNS,
  REVIEWER_AGENT_TEXT,
  WORKFLOWS,
} from './fixtures';

type Send<T> = (message: T) => void;

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
    case 'invalid':
      return review.replace('prompt:', 'promt:');
    case 'syntax':
      return review.replace('steps:\n', 'steps:\n   broken: [\n');
    case 'approval': {
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

async function collectEvents(workflow: Workflow, host: EngineHost, signal?: AbortSignal, onEvent?: (e: RunEvent) => void) {
  let clock = Date.UTC(2026, 9, 26, 9, 26);
  const events: RunEvent[] = [];
  const generator = runWorkflow(workflow, {
    runId: 'run-live',
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

export function workflowHost(scenario: string, send: Send<HostToWorkflowEditor>) {
  let text = scenarioWorkflowText(scenario);
  let controller: AbortController | undefined;
  let liveView: RunView | null = null;
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
    const host = createFakeHost({
      delayMs: 350,
      approval: (stepId, message) =>
        new Promise<ApprovalResult>((resolve) => {
          const requestId = `approval-${Math.random().toString(36).slice(2)}`;
          pendingApprovals.set(requestId, resolve);
          send({ type: 'approvalRequest', prompt: { requestId, runId: 'run-live', stepId, message } });
        }),
    });
    void inputs;
    await collectEvents(workflow, host, controller.signal, (event) => {
      liveView = reduceRunEvent(liveView, event);
      send({ type: 'runEvent', event });
    });
  };

  return (message: WorkflowEditorToHost) => {
    switch (message.type) {
      case 'ready':
        // 'syntax': the file was readable before the last keystroke, so the canvas keeps the last valid model.
        if (scenario === 'syntax') send({ type: 'document', doc: doc(scenarioWorkflowText('default')) });
        send({ type: 'document', doc: doc() });
        send({ type: 'catalog', agents: AGENTS, catalog: CATALOG });
        send({ type: 'trust', trusted: scenario !== 'untrusted' });
        send({ type: 'history', runs: RECENT_RUNS.filter((r) => r.workflowUri === WORKFLOW_URI) });
        void prepareScenario().then(markReady);
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
      case 'selectRun':
        send({ type: 'run', run: message.runId ? null : liveView, live: message.runId === null });
        break;
      default:
        console.info('[mock host] workflow message', message);
    }
  };
}

/* ---------------- sidebar ---------------- */

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
  const liveRun = (workflow: (typeof WORKFLOWS)[number], startedAt: number) => ({
    runId: `run-live-${startedAt}`,
    workflowUri: workflow.uri,
    workflowName: workflow.name,
    status: 'running' as const,
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
        : [...AGENTS],
    workflows: empty ? [] : messy ? [...WORKFLOWS, { uri: 'file:///c%3A/work/shop/broken.workflow.yaml', name: '', relativePath: 'broken.workflow.yaml', valid: false, stepCount: 0 }] : [...WORKFLOWS],
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
    recentRuns: empty ? [] : running ? [running, ...RECENT_RUNS] : RECENT_RUNS,
    activeRuns: running ? [running.workflowUri] : [],
    tab: ['workflows', 'untrusted', 'running', 'newworkflow'].some(has) ? 'workflows' : 'agents',
  };
  const push = () => send({ type: 'state', state: { ...state } });
  const finishRun = (runId: string, status: 'success' | 'cancelled') => {
    const run = state.recentRuns.find((r) => r.runId === runId);
    if (!run || run.status !== 'running') return;
    state.recentRuns = state.recentRuns.map((r) => (r.runId === runId ? { ...r, status, durationMs: Date.now() - r.startedAt } : r));
    state.activeRuns = state.activeRuns.filter((uri) => uri !== run.workflowUri);
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
      case 'createAgent':
        state.agents = [
          ...state.agents,
          { id: message.name.toLowerCase().replace(/\W+/g, '-'), name: message.name, model: 'vscode/copilot/gpt-4.1', tools: [], scope: message.scope, uri: 'file:///new.agent.yaml', valid: true },
        ];
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
        state.activeRuns = [...state.activeRuns, message.uri];
        state.recentRuns = [run, ...state.recentRuns];
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
        : REVIEWER_AGENT_TEXT;
  const id = scenario === 'new' ? 'translator' : 'reviewer';
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
      usedBy: id === 'reviewer' ? ['.isarflow/workflows/review-loop.workflow.yaml'] : [],
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
