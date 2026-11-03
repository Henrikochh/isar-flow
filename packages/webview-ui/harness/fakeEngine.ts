/** The real engine driven by a scripted host, for live harness runs and the seeded run history. */
import {
  reduceRunEvent,
  runRecordSummary,
  runWorkflow,
  type ApprovalResult,
  type AskRequest,
  type AskResult,
  type EditorContext,
  type EngineHost,
  type GitContext,
  type ResumeOptions,
  type ReviewCounts,
  type RunEvent,
  type RunOrigin,
  type RunRecordSummary,
  type RunView,
  type StepIO,
  type Workflow,
} from '@isar-flow/core';
import { AGENTS } from './fixtures';
import { sleep } from './mockShared';

export const WORKFLOW_URI = 'file:///c%3A/work/shop/.isarflow/workflows/review-loop.workflow.yaml';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface FakeHostOptions {
  failTests?: boolean;
  /** The tests pass from the first call on (by default the first call fails). */
  passTests?: boolean;
  /** The reviewer approves from this round on (default 2). */
  approveAfter?: number;
  delayMs?: number;
  approval?: (stepId: string, message: string) => Promise<ApprovalResult>;
  /** Answers ask blocks; without it the engine uses their default (else the first choice). */
  ask?: (req: AskRequest, io: StepIO) => Promise<AskResult>;
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

/** What the release workflow's deploy block prints. */
function deployLines(command: string): string[] {
  const env = /--env\s+(\S+)/.exec(command)?.[1] || 'dev';
  return [
    '> shop@1.4.0 deploy',
    `> node scripts/deploy.mjs --env ${env}`,
    '',
    `Building shop for ${env}…`,
    'Uploading 38 files (2.4 MB)',
    `Deployed to https://${env}.shop.example.com in 21 s`,
  ];
}

const SUMMARY =
  'Released the voucher fixes: applyVoucher() no longer runs twice when the cart is re-validated, and expired vouchers are rejected with a clear message.';

/** Scripted host: tests fail once, the reviewer approves on round `approveAfter`; agents report tools and tokens. */
export function createFakeHost(options: FakeHostOptions = {}): EngineHost {
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
      if (req.stepId === 'deploy') {
        const lines = deployLines(req.command);
        for (const line of lines) {
          io.log('stdout', `${line}\n`);
          await pause(io.signal);
        }
        const output = lines.join('\n') + '\n';
        return { exitCode: 0, stdout: output, stderr: '', output, timedOut: false };
      }
      const n = count(req.stepId);
      const failing = options.failTests || (n === 1 && !options.passTests);
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
      if (req.stepId === 'summarize') {
        io.log('tool', 'gitDiff → 3 files changed, 48 insertions(+), 6 deletions(-)\n');
        await pause(io.signal);
        io.log('agent', SUMMARY);
        const usage = { inputTokens: 9_800, outputTokens: 420 };
        return { text: SUMMARY, model: req.agent.model, usage, turns: 2, toolCalls: 1, messages: [] };
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
    ...(options.ask && { askUser: options.ask }),
  };
}

function harnessAgents() {
  const definitions: Record<string, { name: string; model: string }> = {};
  for (const a of AGENTS) definitions[a.id] = { name: a.name, model: a.model };
  return definitions;
}

export interface CollectOptions {
  runId?: string;
  /** Start of the scripted clock. Runs with `onEvent` are live and use the real clock. */
  startedAt?: number;
  /** Scripted time per event, so past runs differ in duration. */
  tickMs?: number;
  inputs?: Record<string, unknown>;
  /** Run from here: continue a past run at a block. */
  resume?: ResumeOptions;
  /** Test mode: marks the run as simulated (the caller passes a simulation host). */
  simulated?: boolean;
  /** Workspace-relative path of the workflow file (default: the review loop). */
  workflowFile?: string;
  /** `editor.*` and `git.*` as captured when the run starts, and how it was started. */
  editor?: EditorContext;
  git?: GitContext;
  origin?: RunOrigin;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

export async function collectEvents(
  workflow: Workflow,
  host: EngineHost,
  {
    runId = 'run-live',
    startedAt = Date.UTC(2026, 9, 26, 9, 26),
    tickMs = 1700,
    inputs = { task: 'Add voucher codes to the checkout' },
    resume,
    simulated,
    workflowFile = '.isarflow/workflows/review-loop.workflow.yaml',
    editor,
    git,
    origin,
    signal,
    onEvent,
  }: CollectOptions = {},
): Promise<RunEvent[]> {
  let clock = startedAt;
  const events: RunEvent[] = [];
  const generator = runWorkflow(workflow, {
    runId,
    inputs,
    host,
    agents: harnessAgents(),
    workspaceRoot: 'C:/work/shop',
    workflowFile,
    signal,
    now: onEvent ? undefined : () => (clock += tickMs),
    ...(resume ? { resume } : {}),
    ...(simulated ? { simulated } : {}),
    ...(editor ? { editor } : {}),
    ...(git ? { git } : {}),
    ...(origin ? { origin } : {}),
  });
  for (;;) {
    const next = await generator.next();
    if (next.done) break;
    events.push(next.value);
    onEvent?.(next.value);
  }
  return events;
}

export function viewOf(events: RunEvent[]): RunView | null {
  return events.reduce<RunView | null>((view, event) => reduceRunEvent(view, event), null);
}

/** A finished run as the host keeps it: the summary for the history list and the view to show it again. */
export interface PastRun {
  summary: RunRecordSummary;
  view: RunView;
}

export function pastRun(view: RunView, review?: ReviewCounts, uri = WORKFLOW_URI): PastRun {
  const summary = runRecordSummary(view, uri);
  return { summary: review ? { ...summary, review } : summary, view };
}
