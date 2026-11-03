/**
 * Workflow editor scenarios of "Build faster" (Package B): Run from here, simulated runs and the simulation file.
 * They only add runs on top of the seeded history; the default history stays as it is.
 */
import {
  applyWorkflowOps,
  createSimulationHost,
  resumeOptions,
  type HostToWorkflowEditor,
  type RunView,
  type SimulationFile,
  type Workflow,
} from '@isar-flow/core';
import { FIXTURE_NOW } from './fixtures';
import { collectEvents, createFakeHost, MINUTE, pastRun, type PastRun, viewOf } from './fakeEngine';
import type { Send } from './mockShared';

export const BUILD_FASTER_SCENARIOS = [
  'resume',
  'resume-changed',
  'resumed',
  'simulated',
  'runs-markers',
  'live',
  'live-long',
  'simulation',
  'simulation-console',
  'simulation-errors',
  'simulation-broken',
];

/** The review loop as the scenario shows it; 'resume-changed' edited implement's prompt since run-3. */
export function buildFasterText(scenario: string, review: string): string {
  if (scenario !== 'resume-changed') return review;
  const prompt =
    'Implement the following task in this repository and cover it with tests:\n${{ inputs.task }}\n';
  return applyWorkflowOps(review, [{ op: 'updateStep', stepId: 'implement', set: { prompt } }]).text;
}

/** Blocks the scenario selects in the inspector. */
const SELECTED: Record<string, string> = {
  resume: 'tests',
  'resume-changed': 'tests',
  simulation: 'review',
  'simulation-console': 'tests',
  'simulation-errors': 'review',
  'simulation-broken': 'tests',
};

export interface ScenarioContext {
  workflow: Workflow;
  history: () => PastRun[];
  setHistory: (runs: PastRun[]) => void;
  showRun: (run: RunView | null, live: boolean) => void;
  send: Send<HostToWorkflowEditor>;
  simulationFile: () => SimulationFile;
}

/** A finished run that continued run-3 at `tests`: the tests pass and the reviewer approves. */
export async function resumedRun(workflow: Workflow, source: RunView, runId: string, ago: number) {
  const events = await collectEvents(workflow, createFakeHost({ passTests: true, approveAfter: 1 }), {
    runId,
    startedAt: FIXTURE_NOW - ago,
    resume: resumeOptions(workflow, source, 'tests'),
  });
  return viewOf(events);
}

/** A finished simulated run with the scenario's mocks. */
export async function simulatedRun(workflow: Workflow, file: SimulationFile, runId: string, ago: number) {
  const events = await collectEvents(workflow, createSimulationHost({ file }), {
    runId,
    startedAt: FIXTURE_NOW - ago,
    tickMs: 400,
    simulated: true,
  });
  return viewOf(events);
}

/** A task pasted from a ticket: longer than the 2 KB a live value shows. */
export const LONG_TASK = [
  'Add voucher codes to the checkout.',
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `${i + 1}. Voucher rule ${i + 1}: apply it once per cart, keep it after re-validation, and log it.`,
  ),
].join('\n');

/** A finished run of the review loop with the long task, as the newest run. */
async function longTaskRun(workflow: Workflow, runId: string, ago: number) {
  const events = await collectEvents(workflow, createFakeHost({ passTests: true, approveAfter: 1 }), {
    runId,
    startedAt: FIXTURE_NOW - ago,
    inputs: { task: LONG_TASK },
  });
  return viewOf(events);
}

/** Sets up a build-faster scenario; false when `scenario` is not one of them. */
export async function prepareBuildFaster(scenario: string, context: ScenarioContext): Promise<boolean> {
  if (!BUILD_FASTER_SCENARIOS.includes(scenario)) return false;
  const { workflow, history, setHistory, showRun, send } = context;
  const source = history().find((run) => run.summary.runId === 'run-3')?.view;
  if ((scenario === 'resume' || scenario === 'resume-changed') && source) showRun(source, false);
  if (scenario === 'resumed' && source) {
    const view = await resumedRun(workflow, source, 'run-8', 2 * MINUTE);
    if (view) {
      setHistory([pastRun(view), ...history()]);
      showRun(view, true);
    }
  }
  if (scenario === 'simulated') {
    const view = await simulatedRun(workflow, context.simulationFile(), 'run-8', 2 * MINUTE);
    if (view) {
      setHistory([pastRun(view), ...history()]);
      showRun(view, true);
    }
  }
  if (scenario === 'live-long') {
    const view = await longTaskRun(workflow, 'run-8', MINUTE);
    if (view) setHistory([pastRun(view), ...history()]);
  }
  if (scenario === 'runs-markers' && source) {
    const resumed = await resumedRun(workflow, source, 'run-8', 3 * MINUTE);
    const simulated = await simulatedRun(workflow, context.simulationFile(), 'run-9', MINUTE);
    if (resumed && simulated) setHistory([pastRun(simulated), pastRun(resumed), ...history()]);
  }
  const selected = SELECTED[scenario];
  if (selected) send({ type: 'focusStep', stepId: selected });
  return true;
}
