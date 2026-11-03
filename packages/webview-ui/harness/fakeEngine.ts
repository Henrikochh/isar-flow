/** The real engine driven by a scripted host, for live harness runs and the seeded run history. */
import {
  reduceRunEvent,
  runRecordSummary,
  runWorkflow,
  type ApprovalResult,
  type EngineHost,
  type ResumeOptions,
  type ReviewCounts,
  type RunEvent,
  type RunRecordSummary,
  type RunView,
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
    workflowFile: '.isarflow/workflows/review-loop.workflow.yaml',
    signal,
    now: onEvent ? undefined : () => (clock += tickMs),
    ...(resume ? { resume } : {}),
    ...(simulated ? { simulated } : {}),
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

export function pastRun(view: RunView, review?: ReviewCounts): PastRun {
  const summary = runRecordSummary(view, WORKFLOW_URI);
  return { summary: review ? { ...summary, review } : summary, view };
}
