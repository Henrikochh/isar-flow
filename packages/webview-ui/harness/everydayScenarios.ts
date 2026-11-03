/**
 * Workflow editor scenarios of "Everyday use" (Package C): the release workflow with ask blocks, triggers, Copilot
 * access and runs started in different ways. They show the release workflow with its own history; every other
 * scenario keeps the review loop and its seeded history as they are.
 */
import {
  triggerSummaries,
  type AskRequest,
  type AskResult,
  type EditorContext,
  type HostToWorkflowEditor,
  type RunEvent,
  type RunOrigin,
  type RunReview,
  type RunView,
  type StepIO,
  type Workflow,
  type WorkflowTriggerState,
} from '@isar-flow/core';
import {
  EDITOR_CONTEXT,
  GIT_CONTEXT,
  RELEASE_LONG_TRIGGERS_TEXT,
  RELEASE_MANY_CHOICES_TEXT,
  RELEASE_SIMULATION_PATH,
  RELEASE_WORKFLOW_FILE,
  RELEASE_WORKFLOW_TEXT,
  RELEASE_WORKFLOW_URI,
} from './everydayFixtures';
import { collectEvents, createFakeHost, HOUR, MINUTE, pastRun, type PastRun, viewOf } from './fakeEngine';
import { FIXTURE_NOW } from './fixtures';
import type { Send } from './mockShared';
import { pendingReview } from './reviews';

export const EVERYDAY_SCENARIOS = [
  // A live run waiting at an ask block; answering lets it go on.
  'ask',
  'ask-free',
  'ask-many',
  'ask-two',
  'ask-expired',
  'ask-review',
  'ask-settings',
  'ask-output',
  'triggers',
  'triggers-paused',
  'triggers-limited',
  'triggers-disabled',
  'triggers-untrusted',
  'triggers-invalid',
  'triggers-inputs',
  'triggers-long',
  'triggers-settings',
  'origins',
  'report-menu',
  'simulation-ask',
];

export const isEverydayScenario = (scenario: string) => EVERYDAY_SCENARIOS.includes(scenario);

export const RELEASE_FILE_NAME = 'release.workflow.yaml';
export { RELEASE_SIMULATION_PATH, RELEASE_WORKFLOW_FILE, RELEASE_WORKFLOW_URI };

export function everydayText(scenario: string): string {
  switch (scenario) {
    case 'ask-many':
      return RELEASE_MANY_CHOICES_TEXT;
    case 'triggers-long':
      return RELEASE_LONG_TRIGGERS_TEXT;
    // A schedule more often than once a minute: the workflow is invalid, so its triggers pause.
    case 'triggers-invalid':
      return RELEASE_WORKFLOW_TEXT.replace('every: 1h', 'every: 30s');
    // A required input without a default: nobody can enter it when a trigger starts the run.
    case 'triggers-inputs':
      return RELEASE_WORKFLOW_TEXT.replace(
        'expose: true\n',
        'expose: true\ninputs:\n  version:\n    type: string\n    required: true\n',
      );
    default:
      return RELEASE_WORKFLOW_TEXT;
  }
}

/* ---------- runs ---------- */

/** The editor of runs started by a trigger or Copilot: a file is open, nothing is selected. */
const NO_SELECTION: EditorContext = { selection: '', file: 'src/app.ts', language: 'typescript', line: 1 };

interface ReleaseRun {
  runId: string;
  ago: number;
  origin?: RunOrigin;
  /** Answers of the ask blocks; the others take their default. */
  answers?: Record<string, string>;
  tickMs?: number;
}

/** Runs of the release workflow before the harness opened, newest first: started on save, by Copilot, … */
const HISTORY: ReleaseRun[] = [
  { runId: 'run-12', ago: 3 * MINUTE, origin: { kind: 'trigger', trigger: 'save', file: 'src/app.ts' } },
  { runId: 'run-11', ago: 25 * MINUTE, origin: { kind: 'copilot' }, answers: { 'pick-env': 'staging' } },
  {
    runId: 'run-10',
    ago: 70 * MINUTE,
    origin: { kind: 'selection' },
    answers: { 'pick-env': 'staging', 'release-notes': 'Expired vouchers are rejected' },
  },
  { runId: 'run-9', ago: 2 * HOUR + 5 * MINUTE, origin: { kind: 'trigger', trigger: 'schedule' } },
  {
    runId: 'run-8',
    ago: 26 * HOUR,
    answers: { 'pick-env': 'prod', 'release-notes': 'Vouchers for everyone' },
    tickMs: 2300,
  },
];

const scriptedAnswer =
  (answers: Record<string, string> = {}) =>
  async (req: AskRequest): Promise<AskResult> => ({
    answer: answers[req.stepId] ?? req.default ?? req.choices?.[0] ?? '',
  });

/** Options every release run shares: no inputs, the editor and git state when it started, its file. */
export function releaseRunOptions(origin?: RunOrigin) {
  return {
    inputs: {},
    workflowFile: RELEASE_WORKFLOW_FILE,
    editor: !origin || origin.kind === 'selection' ? EDITOR_CONTEXT : NO_SELECTION,
    git: GIT_CONTEXT,
    ...(origin ? { origin } : {}),
  };
}

async function releaseRun(workflow: Workflow, run: ReleaseRun): Promise<RunView | null> {
  const events = await collectEvents(workflow, createFakeHost({ ask: scriptedAnswer(run.answers) }), {
    ...releaseRunOptions(run.origin),
    runId: run.runId,
    startedAt: FIXTURE_NOW - run.ago,
    tickMs: run.tickMs ?? 1700,
  });
  return viewOf(events);
}

export async function releaseHistory(workflow: Workflow): Promise<PastRun[]> {
  const runs: PastRun[] = [];
  for (const run of HISTORY) {
    const view = await releaseRun(workflow, run);
    if (view) runs.push(pastRun(view, undefined, RELEASE_WORKFLOW_URI));
  }
  return runs;
}

/** Waits for the abort of an unanswered question, like a person who never answers. */
const never = (_req: AskRequest, io: StepIO) =>
  new Promise<AskResult>((_resolve, reject) =>
    io.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }),
  );

/**
 * A finished run in which nobody answered pick-env, so its default was used. The engine times out for real on a
 * copy with a 20 ms timeout; the log then names the block's own timeout again.
 */
async function timedOutRun(workflow: Workflow): Promise<RunView | null> {
  const quick: Workflow = {
    ...workflow,
    steps: workflow.steps.map((step) => (step.id === 'pick-env' ? { ...step, timeout: 0.02 } : step)),
  };
  const ask = (req: AskRequest, io: StepIO) =>
    req.stepId === 'pick-env' ? never(req, io) : scriptedAnswer({ 'release-notes': 'Faster checkout' })(req);
  const events = await collectEvents(quick, createFakeHost({ ask }), {
    ...releaseRunOptions(),
    runId: 'run-13',
    startedAt: FIXTURE_NOW - 2 * MINUTE,
  });
  const fixed = events.map((event): RunEvent =>
    event.type === 'step-log' ? { ...event, text: event.text.replace('within 0.02s', 'within 300s') } : event,
  );
  return viewOf(fixed);
}

/* ---------- triggers ---------- */

const APPROVAL =
  "Run 'Release to an environment' once and choose 'Run and remember' so its triggers can start it.";
const LIMITED =
  "'Release to an environment' started 10 times in 10 minutes, so its triggers are paused. Resume them when you're ready.";

type Paused = Pick<WorkflowTriggerState, 'pausedReason' | 'pausedMessage'>;

const PAUSED: Record<string, Paused> = {
  'triggers-paused': { pausedReason: 'approval', pausedMessage: APPROVAL },
  'triggers-limited': { pausedReason: 'limited', pausedMessage: LIMITED },
  'triggers-disabled': {
    pausedReason: 'disabled',
    pausedMessage: 'Triggers are turned off in the settings (isarFlow.triggers.enabled).',
  },
  'triggers-untrusted': {
    pausedReason: 'untrusted',
    pausedMessage: 'Triggers only run in trusted workspaces. Trust this workspace to turn them on.',
  },
  'triggers-invalid': {
    pausedReason: 'invalid',
    pausedMessage: 'The workflow has problems. Fix them to turn its triggers on.',
  },
  'triggers-inputs': {
    pausedReason: 'inputs',
    pausedMessage: "Triggers can't ask for inputs. Give input 'version' a default or make it optional.",
  },
};

/**
 * The trigger state the host sends for a scenario's workflow (none for the review loop). Active schedules run
 * next in 12 minutes; the last trigger fired on save 3 minutes ago ('triggers-long': it skipped that start).
 */
export function triggerState(
  scenario: string,
  workflow: Workflow | null,
  resumed: boolean,
  now = Date.now(),
): WorkflowTriggerState {
  const triggers = triggerSummaries(workflow?.on);
  if (!triggers.length) return { triggers, status: 'active' };
  const lastFired = {
    at: now - 3 * MINUTE,
    kind: 'save' as const,
    file: 'src/app.ts',
    ...(scenario === 'triggers-long'
      ? { skipped: 'The workflow was already running.' }
      : { runId: 'run-12' }),
  };
  const paused = resumed ? undefined : PAUSED[scenario];
  if (paused) return { triggers, status: 'paused', ...paused, lastFired };
  const schedule = triggers.some((trigger) => trigger.kind === 'schedule');
  return { triggers, status: 'active', lastFired, ...(schedule ? { nextRunAt: now + 12 * MINUTE } : {}) };
}

/* ---------- live asks ---------- */

/** Asks a live run answers by itself before it waits for the person ('ask-free': pick-env was answered). */
export function autoAnswer(scenario: string, stepId: string): string | undefined {
  return scenario === 'ask-free' && stepId === 'pick-env' ? 'staging' : undefined;
}

/** When a question of a live run times out: from its timeout, or already over ('ask-expired'). */
export function askExpiresAt(scenario: string, timeoutMs: number | undefined, now = Date.now()) {
  if (scenario === 'ask-expired') return now - 5_000;
  return timeoutMs !== undefined ? now + timeoutMs : undefined;
}

/* ---------- scenario setup ---------- */

/** Blocks the scenario selects in the inspector. */
const SELECTED: Record<string, string> = {
  'ask-settings': 'pick-env',
  'ask-output': 'pick-env',
  'simulation-ask': 'pick-env',
};

/** Scenarios that start a live run at once; it stops at the first question nobody answers. */
const LIVE = new Set(['ask', 'ask-free', 'ask-many', 'ask-two', 'ask-expired', 'ask-review']);

export interface EverydayContext {
  workflow: Workflow;
  history: () => PastRun[];
  setHistory: (runs: PastRun[]) => void;
  showRun: (run: RunView | null, live: boolean) => void;
  send: Send<HostToWorkflowEditor>;
  /** Starts a live run and resolves once it waits for an answer (or has ended). */
  startAndWaitForAsk: () => Promise<{ runId: string } | undefined>;
  setReview: (runId: string, review: RunReview) => void;
}

/** Sets up an everyday scenario after the history was seeded; false when `scenario` is not one of them. */
export async function prepareEveryday(scenario: string, context: EverydayContext): Promise<boolean> {
  if (!isEverydayScenario(scenario)) return false;
  const { workflow, history, setHistory, showRun, send } = context;
  if (LIVE.has(scenario)) {
    const live = await context.startAndWaitForAsk();
    if (live && scenario === 'ask-two') {
      // A second question at the same time, e.g. from a host that re-sent one: both cards stack.
      send({
        type: 'askRequest',
        prompt: {
          requestId: 'ask-extra',
          runId: live.runId,
          stepId: 'release-notes',
          question: 'What should the release notes say?',
          default: 'Routine release',
        },
      });
    }
    if (live && scenario === 'ask-review') context.setReview(live.runId, pendingReview(live.runId));
  } else if (scenario === 'ask-output') {
    const view = await timedOutRun(workflow);
    if (view) {
      setHistory([pastRun(view, undefined, RELEASE_WORKFLOW_URI), ...history()]);
      showRun(view, true);
    }
  } else if (scenario === 'origins' || scenario === 'report-menu') {
    // The newest run, started on save, is on the canvas.
    const newest = history()[0];
    if (newest) showRun(newest.view, false);
  }
  const selected = SELECTED[scenario];
  if (selected) send({ type: 'focusStep', stepId: selected });
  return true;
}
