/**
 * Workflow editor side of the mock host: real core ops, validation and engine, a scripted engine host, a seeded
 * run history, reviews of the files runs changed, the simulation file, runs that simulate or continue a past run,
 * questions of ask blocks and the state of the workflow's triggers.
 */
import {
  applyWorkflowOps,
  createSimulationHost,
  liveContext,
  newWorkflowText,
  parseWorkflowText,
  reduceRunEvent,
  resumeOptions,
  validateWorkflow,
  workflowTemplate,
  type ApprovalResult,
  type AskResult,
  type EngineHost,
  type HostToWorkflowEditor,
  type ResumeOptions,
  type ReviewDecision,
  type ReviewFile,
  type RunReview,
  type RunView,
  type Workflow,
  type WorkflowDocumentState,
  type WorkflowEditorToHost,
} from '@isar-flow/core';
import { buildFasterText, prepareBuildFaster } from './buildFasterScenarios';
import {
  askExpiresAt,
  autoAnswer,
  everydayText,
  isEverydayScenario,
  prepareEveryday,
  RELEASE_FILE_NAME,
  RELEASE_WORKFLOW_URI,
  releaseHistory,
  releaseRunOptions,
  triggerState,
} from './everydayScenarios';
import {
  collectEvents,
  createFakeHost,
  DAY,
  type FakeHostOptions,
  HOUR,
  MINUTE,
  pastRun,
  type PastRun,
  viewOf,
  WORKFLOW_URI,
} from './fakeEngine';
import {
  AGENTS,
  ALL_BLOCKS_WORKFLOW_TEXT,
  CATALOG,
  FIXTURE_NOW,
  LONG_TEXT_WORKFLOW_TEXT,
  NESTED_WORKFLOW_TEXT,
} from './fixtures';
import { markReady, probe, type Send, sleep } from './mockShared';
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
import { simulationMock } from './simulationMock';

function scenarioWorkflowText(scenario: string): string {
  if (isEverydayScenario(scenario)) return everydayText(scenario);
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
      return buildFasterText(scenario, review);
  }
}

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

/** How a live run starts: a normal run, a simulation, or a run that continues a past one at a block. */
interface StartOptions {
  inputs?: Record<string, unknown>;
  simulated?: boolean;
  resumeFrom?: { runId: string; stepId: string };
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
  const answers: { requestId: string; answer: string }[] = [];
  probe.answers = () => answers;
  const reports: { runId: string; action: string }[] = [];
  probe.reports = () => reports;
  const settingsQueries: string[] = [];
  probe.settingsQueries = () => settingsQueries;
  let resumedTriggers = 0;
  probe.resumedTriggers = () => resumedTriggers;
  /** The release workflow of the everyday scenarios, else the review loop. */
  const release = isEverydayScenario(scenario);
  const workflowUri = release ? RELEASE_WORKFLOW_URI : WORKFLOW_URI;
  const simulation = simulationMock(scenario, send);
  let controller: AbortController | undefined;
  let liveView: RunView | null = null;
  /** Finished runs, newest first; `selectRun` shows them again. */
  let history: PastRun[] = [];
  /** Reviews by run id; `omitted` is the decision shared by the files a review does not list. */
  const reviews = new Map<string, { review: RunReview; omitted: ReviewDecision }>();
  /** Run shown on the canvas: reviews are sent for it only. */
  let shownRunId: string | null = null;
  /** Newest run whose context was sent as `lastRunContext`; undefined before the first one. */
  let contextRunId: string | null | undefined;
  const sendHistory = () => {
    send({ type: 'history', runs: history.map((run) => run.summary) });
    // Like the extension: live values read the newest finished run.
    const newest = history[0];
    if ((newest?.summary.runId ?? null) === contextRunId) return;
    contextRunId = newest?.summary.runId ?? null;
    send({ type: 'lastRunContext', context: newest ? liveContext(newest.view) : null });
  };
  const pendingApprovals = new Map<string, (result: ApprovalResult) => void>();
  const pendingAsks = new Map<string, (result: AskResult) => void>();
  /** Id of the newest live run. */
  let liveRunId: string | null = null;
  const currentWorkflow = () => parseWorkflowText(text).workflow;
  const sendTriggers = () =>
    send({ type: 'triggers', triggers: triggerState(scenario, currentWorkflow(), resumedTriggers > 0) });

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
      uri: workflowUri,
      fileName: release ? RELEASE_FILE_NAME : 'review-loop.workflow.yaml',
      text: source,
      workflow: parsed.workflow,
      valid: parsed.valid && !diagnostics.some((d) => d.severity === 'error'),
      diagnostics,
    };
  };

  const seedHistory = async () => {
    if (release) {
      const workflow = currentWorkflow();
      if (workflow) history = await releaseHistory(workflow);
      return;
    }
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
    const everyday = await prepareEveryday(scenario, {
      workflow,
      history: () => history,
      setHistory: (runs) => {
        history = runs;
        sendHistory();
      },
      showRun,
      send,
      startAndWaitForAsk: async () => {
        void startRun();
        // The first question comes right away, sometimes before the run is on the canvas; give up after 3 s (the
        // run may have ended without one).
        const waiting = () => pendingAsks.size === 0 || shownRunId !== liveRunId;
        for (let i = 0; i < 150 && waiting(); i++) await sleep(20);
        return liveRunId ? { runId: liveRunId } : undefined;
      },
      setReview: (runId, review) => setReview(runId, review),
    });
    if (everyday) return;
    const handled = await prepareBuildFaster(scenario, {
      workflow,
      history: () => history,
      setHistory: (runs) => {
        history = runs;
        sendHistory();
      },
      showRun,
      send,
      simulationFile: () => {
        const mocks = simulation.load(workflow);
        return 'file' in mocks ? mocks.file : {};
      },
    });
    if (handled) return;
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

  /** The engine host of a live run, or why it can't start (shown as a message by the extension). */
  const liveHost = (
    workflow: Workflow,
    runId: string,
    { simulated, resumeFrom }: StartOptions,
  ): { host: EngineHost; resume?: ResumeOptions } | { error: string } => {
    if (simulated) {
      const mocks = simulation.load(workflow);
      if ('error' in mocks) return mocks;
      return { host: createSimulationHost({ file: mocks.file, delayMs: liveDelayMs }) };
    }
    let resume: ResumeOptions | undefined;
    if (resumeFrom) {
      const source = history.find((run) => run.summary.runId === resumeFrom.runId);
      if (!source) return { error: 'That run is no longer in the history. Run the workflow instead.' };
      try {
        resume = resumeOptions(workflow, source.view, resumeFrom.stepId);
      } catch (error) {
        return { error: (error as Error).message };
      }
    }
    const host = createFakeHost({
      delayMs: liveDelayMs,
      // A resumed run gets past the failing tests it was started to retry.
      ...(resume ? { passTests: true, approveAfter: 1 } : {}),
      approval: (stepId, message) =>
        new Promise<ApprovalResult>((resolve) => {
          const requestId = `approval-${Math.random().toString(36).slice(2)}`;
          pendingApprovals.set(requestId, resolve);
          send({ type: 'approvalRequest', prompt: { requestId, runId, stepId, message } });
        }),
      ask: (req, io) => {
        const auto = autoAnswer(scenario, req.stepId);
        if (auto !== undefined) return Promise.resolve({ answer: auto });
        return new Promise<AskResult>((resolve, reject) => {
          const requestId = `ask-${Math.random().toString(36).slice(2)}`;
          const expiresAt = askExpiresAt(scenario, req.timeoutMs);
          pendingAsks.set(requestId, resolve);
          send({
            type: 'askRequest',
            prompt: {
              requestId,
              runId,
              stepId: req.stepId,
              question: req.question,
              ...(req.choices ? { choices: req.choices } : {}),
              ...(req.default !== undefined ? { default: req.default } : {}),
              ...(expiresAt !== undefined ? { expiresAt } : {}),
            },
          });
          // A timeout or Stop ends the question: the card goes away like the extension's.
          io.signal.addEventListener(
            'abort',
            () => {
              if (!pendingAsks.delete(requestId)) return;
              send({ type: 'askResolved', requestId });
              reject(new Error('Cancelled'));
            },
            { once: true },
          );
        });
      },
    });
    return resume ? { host, resume } : { host };
  };

  const startRun = async (options: StartOptions = {}) => {
    const workflow = currentWorkflow();
    if (!workflow) return;
    const runId = `run-${Date.now().toString(36)}`;
    liveRunId = runId;
    const engine = liveHost(workflow, runId, options);
    if ('error' in engine) {
      console.info('[mock host]', engine.error);
      return;
    }
    controller = new AbortController();
    liveView = null;
    await collectEvents(workflow, engine.host, {
      runId,
      signal: controller.signal,
      ...(release ? releaseRunOptions() : {}),
      ...(options.inputs ? { inputs: options.inputs } : {}),
      ...(engine.resume ? { resume: engine.resume } : {}),
      ...(options.simulated ? { simulated: true } : {}),
      onEvent: (event) => {
        // The canvas switches to the live run when it starts.
        if (event.type === 'run-start') shownRunId = runId;
        liveView = reduceRunEvent(liveView, event);
        send({ type: 'runEvent', event });
      },
    });
    const finished: RunView | null = liveView;
    if (!finished) return;
    history = [pastRun(finished, undefined, workflowUri), ...history];
    // A simulation changes no files.
    const review = options.simulated ? null : liveReview(finished);
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
        simulation.sendState(currentWorkflow());
        send({ type: 'catalog', agents: AGENTS, catalog: CATALOG });
        send({ type: 'trust', trusted: !scenario.split('-').includes('untrusted') });
        sendTriggers();
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
          for (const op of message.ops) if (op.op === 'renameStep') simulation.rename(op.stepId, op.newId);
          send({ type: 'document', doc: doc() });
          simulation.sendState(currentWorkflow());
          // The extension reads the triggers again whenever the file changes.
          sendTriggers();
        }
        break;
      }
      case 'run':
        void startRun();
        break;
      case 'simulate':
        void startRun({ inputs: message.inputs, simulated: true });
        break;
      case 'runFromHere':
        void startRun({
          inputs: message.inputs,
          resumeFrom: { runId: message.runId, stepId: message.stepId },
        });
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
      case 'answer': {
        answers.push({ requestId: message.requestId, answer: message.answer });
        const resolve = pendingAsks.get(message.requestId);
        pendingAsks.delete(message.requestId);
        resolve?.({ answer: message.answer });
        send({ type: 'askResolved', requestId: message.requestId });
        break;
      }
      // The extension writes the report to a file or the clipboard; the harness only notes the request.
      case 'runReport':
        reports.push({ runId: message.runId, action: message.action });
        break;
      case 'openSettings':
        settingsQueries.push(message.query);
        break;
      case 'resumeTriggers':
        resumedTriggers += 1;
        sendTriggers();
        break;
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
      case 'setSimulationMocks':
        simulation.setMocks(message.stepId, message.results, currentWorkflow());
        break;
      // The extension opens the file beside the editor; the harness only counts the requests.
      case 'openSimulationFile':
        simulation.open();
        break;
      default:
        console.info('[mock host] workflow message', message);
    }
  };
}
