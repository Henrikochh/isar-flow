/**
 * Workflow editor side of the mock host: real core ops, validation and engine, a scripted engine host, a seeded
 * run history and reviews of the files runs changed.
 */
import {
  applyWorkflowOps,
  newWorkflowText,
  parseWorkflowText,
  reduceRunEvent,
  runRecordSummary,
  runWorkflow,
  validateWorkflow,
  workflowTemplate,
  type ApprovalResult,
  type EngineHost,
  type HostToWorkflowEditor,
  type ReviewCounts,
  type ReviewDecision,
  type ReviewFile,
  type RunEvent,
  type RunRecordSummary,
  type RunReview,
  type RunView,
  type Workflow,
  type WorkflowDocumentState,
  type WorkflowEditorToHost,
} from '@isar-flow/core';
import {
  AGENTS,
  ALL_BLOCKS_WORKFLOW_TEXT,
  CATALOG,
  FIXTURE_NOW,
  LONG_TEXT_WORKFLOW_TEXT,
  NESTED_WORKFLOW_TEXT,
} from './fixtures';
import { markReady, probe, sleep, type Send } from './mockShared';
import {
  countsOf,
  doneReview,
  journalReview,
  LONG_REVIEW_FILES,
  manyFilesReview,
  pendingReview,
  READ_ONLY_PATH,
  reviewFixture,
  withOmittedPending,
  worktreeReview,
} from './reviews';

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
    case 'nested-run':
      return NESTED_WORKFLOW_TEXT;
    case 'invalid':
      return review.replace('prompt:', 'promt:');
    case 'syntax':
      return review.replace('steps:\n', 'steps:\n   broken: [\n');
    // Hand-written blocks often lack ids; nothing refers to these two, so only the ids are missing.
    case 'noids':
      return review
        .replace('  - id: implement\n    type: agent', '  - type: agent')
        .replace('- id: fix\n            type: agent', '- type: agent');
    case 'isolation':
      return applyWorkflowOps(review, [
        { op: 'updateWorkflow', set: { isolation: 'worktree', setup: ['npm ci'] } },
      ]).text;
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
  /** The reviewer approves from this round on (default 2). */
  approveAfter?: number;
  delayMs?: number;
  approval?: (stepId: string, message: string) => Promise<ApprovalResult>;
}

const PASSING = [
  '> shop@1.4.0 test',
  '> vitest run',
  '',
  ' ✓ src/cart.test.ts (12 tests)',
  ' ✓ src/checkout.test.ts (20 tests)',
  '',
  ' Tests  32 passed (32)',
];
const FAILING = [
  '> shop@1.4.0 test',
  '> vitest run',
  '',
  ' ✓ src/cart.test.ts (12 tests)',
  ' ✗ src/checkout.test.ts > applies the voucher once',
  '   AssertionError: expected 18.9 to be 19.9',
  '',
  ' Tests  1 failed | 31 passed (32)',
];

/** Scripted host: tests fail once, the reviewer approves on round `approveAfter`; agents report tools and tokens. */
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
      const lines = failing ? FAILING : PASSING;
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
        const approved = n >= (options.approveAfter ?? 2);
        const json = approved
          ? { approved: true, issues: [] }
          : {
              approved: false,
              issues: [
                'Voucher is applied twice when the cart is re-validated',
                'Missing test for expired vouchers',
              ],
            };
        const text = JSON.stringify(json, null, 2);
        io.log('agent', text);
        const usage = { inputTokens: 5_200 + 900 * n, outputTokens: 310 + 40 * n };
        return { text, json, model: req.agent.model, usage, turns: 2, toolCalls: 2, messages: [] };
      }
      const implement = req.stepId === 'implement';
      const text = implement
        ? 'Added voucher support to the checkout: `applyVoucher()` in src/checkout.ts, a `vouchers` table migration and 6 new tests.'
        : 'Fixed the double application by memoising the voucher total and added a test for expired vouchers.';
      io.log('tool', 'readFile src/checkout.ts → 214 lines\n');
      await pause(io.signal);
      io.log('tool', 'editFile src/checkout.ts → replaced 1 occurrence\n');
      for (const word of text.split(' ')) {
        io.log('agent', word + ' ');
        if (options.delayMs) await sleep(25);
      }
      const usage = implement
        ? { inputTokens: 18_400, outputTokens: 1_250 }
        : { inputTokens: 12_900 + 2_100 * n, outputTokens: 860 + 120 * n };
      return {
        text,
        model: req.agent.model,
        usage,
        turns: implement ? 4 : 3,
        toolCalls: implement ? 7 : 4,
        messages: [],
      };
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
  /** Start of the scripted clock. Runs with `onEvent` are live and use the real clock. */
  startedAt?: number;
  /** Scripted time per event, so past runs differ in duration. */
  tickMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

async function collectEvents(
  workflow: Workflow,
  host: EngineHost,
  {
    runId = 'run-live',
    startedAt = Date.UTC(2026, 9, 26, 9, 26),
    tickMs = 1700,
    signal,
    onEvent,
  }: CollectOptions = {},
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
    now: onEvent ? undefined : () => (clock += tickMs),
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

function pastRun(view: RunView, review?: ReviewCounts): PastRun {
  const summary = runRecordSummary(view, WORKFLOW_URI);
  return { summary: review ? { ...summary, review } : summary, view };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Runs of the review workflow from before the harness opened, newest first; they differ in rounds and pace. */
const SEEDS: { runId: string; ago: number; tickMs: number; host: FakeHostOptions }[] = [
  { runId: 'run-7', ago: 4 * MINUTE, tickMs: 1700, host: {} },
  { runId: 'run-6', ago: 3 * HOUR, tickMs: 2100, host: { approveAfter: 3 } },
  { runId: 'run-5', ago: 26 * HOUR, tickMs: 1500, host: {} },
  { runId: 'run-4', ago: 30 * HOUR, tickMs: 1900, host: { approveAfter: 4 } },
  { runId: 'run-3', ago: 2 * DAY, tickMs: 1700, host: { failTests: true } },
  { runId: 'run-2', ago: 4 * DAY, tickMs: 2300, host: { approveAfter: 3 } },
];

/** Reviews of the seeded runs: the newest still has two files to review, the one before is decided. */
const SEED_REVIEWS: Record<string, (runId: string) => RunReview> = {
  'run-7': pendingReview,
  'run-6': doneReview,
};

/** The scenario reviews of the newest run ('run-8', finished just before the harness opened). */
const SCENARIO_REVIEWS: Record<string, (runId: string) => RunReview> = {
  review: (runId) => reviewFixture(runId),
  'review-journal': journalReview,
  'review-worktree': worktreeReview,
  'review-narrow': (runId) => reviewFixture(runId, LONG_REVIEW_FILES),
  'review-many': manyFilesReview,
};

/** Files a live harness run "changed": what its agent blocks wrote. */
function liveReview(view: RunView): RunReview | null {
  // Blocks in a loop may have run in an earlier iteration and been skipped in the last one.
  const ran = (id: string) => (view.steps[id]?.executions ?? 0) > 0;
  const files: ReviewFile[] = [];
  if (ran('implement') || ran('fix'))
    files.push({
      path: 'src/checkout.ts',
      status: 'modified',
      additions: 34,
      deletions: 6,
      stepIds: ['implement', 'fix'].filter(ran),
      decision: 'pending',
      revertible: true,
    });
  if (ran('fix'))
    files.push({
      path: 'src/checkout.test.ts',
      status: 'modified',
      additions: 21,
      deletions: 0,
      stepIds: ['fix'],
      decision: 'pending',
      revertible: true,
    });
  return files.length ? reviewFixture(view.runId, files) : null;
}

/** Keep or revert one pending file the way the host would, including the failures it reports. */
function decideFile(file: ReviewFile, decision: 'kept' | 'reverted'): ReviewFile {
  if (decision === 'reverted' && !file.revertible)
    return { ...file, error: "The state before the run wasn't saved, so this file can't be reverted." };
  if (decision === 'reverted' && file.path === READ_ONLY_PATH)
    return {
      ...file,
      error: `Could not write ${file.path}: the file is read-only. Make it writable and try again.`,
    };
  const { error: _error, ...rest } = file;
  return { ...rest, decision };
}

export interface WorkflowHostOptions {
  /** Pace of live runs (ms per scripted step); 0 runs them at once. */
  liveDelayMs?: number;
}

export function workflowHost(
  scenario: string,
  send: Send<HostToWorkflowEditor>,
  { liveDelayMs = 350 }: WorkflowHostOptions = {},
) {
  let text = scenarioWorkflowText(scenario);
  probe.workflowText = () => text;
  const openedDiffs: { runId: string; path: string }[] = [];
  probe.openedDiffs = () => openedDiffs;
  let controller: AbortController | undefined;
  let liveView: RunView | null = null;
  /** Finished runs, newest first; `selectRun` shows them again. */
  let history: PastRun[] = [];
  /** Reviews by run id; `omitted` is the decision shared by the files a review does not list. */
  const reviews = new Map<string, { review: RunReview; omitted: ReviewDecision }>();
  /** Run shown on the canvas: reviews are sent for it only. */
  let shownRunId: string | null = null;
  const sendHistory = () => send({ type: 'history', runs: history.map((run) => run.summary) });
  const pendingApprovals = new Map<string, (result: ApprovalResult) => void>();

  const sendReview = () =>
    send({ type: 'review', review: (shownRunId && reviews.get(shownRunId)?.review) || null });
  /** Shows a run like the extension does: the run, then its review. */
  const showRun = (run: RunView | null, live: boolean) => {
    shownRunId = run?.runId ?? null;
    send({ type: 'run', run, live });
    sendReview();
  };
  const setReview = (runId: string, review: RunReview, omitted: ReviewDecision = 'pending') => {
    reviews.set(runId, { review: withOmittedPending(review, omitted), omitted });
    history = history.map((run) =>
      run.summary.runId === runId
        ? { ...run, summary: { ...run.summary, review: countsOf(review, omitted) } }
        : run,
    );
    sendHistory();
    if (shownRunId === runId) sendReview();
  };

  const doc = (source = text): WorkflowDocumentState => {
    const parsed = parseWorkflowText(source);
    const semantic = parsed.workflow
      ? validateWorkflow(parsed.workflow, {
          agentIds: AGENTS.map((a) => a.id),
          modelRefs: CATALOG.models.map((m) => m.ref),
        })
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

  const seedHistory = async () => {
    const workflow = parseWorkflowText(scenarioWorkflowText('default')).workflow;
    if (!workflow) return;
    for (const seed of SEEDS) {
      const events = await collectEvents(workflow, createFakeHost(seed.host), {
        runId: seed.runId,
        startedAt: FIXTURE_NOW - seed.ago,
        tickMs: seed.tickMs,
      });
      const view = viewOf(events);
      if (!view) continue;
      const review = SEED_REVIEWS[seed.runId]?.(seed.runId);
      if (review) reviews.set(seed.runId, { review, omitted: 'pending' });
      history.push(pastRun(view, review && countsOf(review)));
    }
  };

  const prepareScenario = async () => {
    const workflow = parseWorkflowText(text).workflow;
    if (!workflow) return;
    const makeReview = SCENARIO_REVIEWS[scenario];
    if (scenario === 'running') {
      const events = await collectEvents(workflow, createFakeHost());
      const cut = events.findIndex(
        (e, i) =>
          e.type === 'step-start' &&
          e.stepId === 'review' &&
          events.slice(0, i).some((p) => p.type === 'loop-iteration' && p.iteration === 2),
      );
      showRun(viewOf(events.slice(0, cut + 1)), true);
      send({ type: 'focusStep', stepId: 'tests' });
    } else if (scenario === 'failed') {
      const events = await collectEvents(workflow, createFakeHost({ failTests: true }));
      showRun(viewOf(events), true);
      send({ type: 'focusStep', stepId: 'tests' });
    } else if (scenario === 'approval') {
      const events = await collectEvents(workflow, createFakeHost());
      const cut = events.findIndex((e) => e.type === 'step-start' && e.stepId === 'ship_it');
      showRun(viewOf(events.slice(0, cut + 1)), true);
      send({
        type: 'approvalRequest',
        prompt: {
          requestId: 'approval-1',
          runId: 'run-live',
          stepId: 'ship_it',
          message: 'Merge the reviewed changes into main?',
        },
      });
    } else if (scenario === 'nested-run' || scenario === 'metrics') {
      // A finished run: skipped cards in the nested workflow; time and tokens per block in 'metrics'.
      const events = await collectEvents(workflow, createFakeHost());
      showRun(viewOf(events), true);
    } else if (scenario === 'history') {
      // A past failed run picked from the history: shown read-only, with its summary in the inspector.
      const failed = history.find((run) => run.summary.status === 'failure');
      if (failed) showRun(failed.view, false);
    } else if (scenario === 'review-done') {
      const decided = history.find((run) => run.summary.runId === 'run-6');
      if (decided) showRun(decided.view, false);
    } else if (makeReview) {
      const events = await collectEvents(workflow, createFakeHost(), {
        runId: 'run-8',
        startedAt: FIXTURE_NOW - 2 * MINUTE,
      });
      const view = viewOf(events);
      if (!view) return;
      const review = makeReview(view.runId);
      reviews.set(view.runId, { review, omitted: 'pending' });
      history = [pastRun(view, countsOf(review)), ...history];
      sendHistory();
      showRun(view, true);
    } else if (scenario === 'selected') {
      send({ type: 'focusStep', stepId: 'review' });
    } else if (scenario === 'condition') {
      const loop = workflow.steps.find((s) => s.type === 'loop');
      const target =
        loop?.type === 'loop'
          ? (loop.steps.find((s) => s.type === 'if')?.id ?? loop.id)
          : workflow.steps[0]?.id;
      if (target) send({ type: 'focusStep', stepId: target });
    }
  };

  const startRun = async () => {
    const workflow = parseWorkflowText(text).workflow;
    if (!workflow) return;
    controller = new AbortController();
    liveView = null;
    const runId = `run-${Date.now().toString(36)}`;
    const host = createFakeHost({
      delayMs: liveDelayMs,
      approval: (stepId, message) =>
        new Promise<ApprovalResult>((resolve) => {
          const requestId = `approval-${Math.random().toString(36).slice(2)}`;
          pendingApprovals.set(requestId, resolve);
          send({ type: 'approvalRequest', prompt: { requestId, runId, stepId, message } });
        }),
    });
    await collectEvents(workflow, host, {
      runId,
      signal: controller.signal,
      onEvent: (event) => {
        // The canvas switches to the live run when it starts.
        if (event.type === 'run-start') shownRunId = runId;
        liveView = reduceRunEvent(liveView, event);
        send({ type: 'runEvent', event });
      },
    });
    const finished: RunView | null = liveView;
    if (!finished) return;
    history = [pastRun(finished), ...history];
    const review = liveReview(finished);
    if (review) setReview(runId, review);
    else sendHistory();
  };

  const decide = (message: Extract<WorkflowEditorToHost, { type: 'reviewFiles' }>) => {
    const entry = reviews.get(message.runId);
    if (!entry || entry.review.busy) return;
    setReview(message.runId, { ...entry.review, busy: true }, entry.omitted);
    setTimeout(() => {
      const { review, omitted } = reviews.get(message.runId) ?? entry;
      const targets = message.paths ? new Set(message.paths) : null;
      const files = review.files.map((f) =>
        f.decision === 'pending' && (!targets || targets.has(f.path)) ? decideFile(f, message.decision) : f,
      );
      const nextOmitted = !targets && omitted === 'pending' ? message.decision : omitted;
      const left =
        files.some((f) => f.decision === 'pending') || (review.omitted && nextOmitted === 'pending');
      const worktreeGone = review.isolation === 'worktree' && !left;
      setReview(
        message.runId,
        { ...review, files, busy: false, ...(worktreeGone ? { worktreeAvailable: false } : {}) },
        nextOmitted,
      );
    }, 300);
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
          await seedHistory();
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
        void startRun();
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
          showRun(liveView, true);
          break;
        }
        const past = history.find((run) => run.summary.runId === message.runId);
        showRun(past?.view ?? null, false);
        break;
      }
      case 'reviewFiles':
        decide(message);
        break;
      // The extension opens VS Code's diff editor; the harness only notes the request.
      case 'openReviewDiff':
        openedDiffs.push({ runId: message.runId, path: message.path });
        break;
      default:
        console.info('[mock host] workflow message', message);
    }
  };
}
