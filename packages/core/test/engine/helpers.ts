import { runWorkflow } from '../../src/engine';
import type { RunEvent, RunOptions, RunSummary, StepOutput } from '../../src/engine/types';
import type { Step, Workflow } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';

export function workflow(steps: Step[], extra: Partial<Workflow> = {}): Workflow {
  return { version: 1, name: 'Test workflow', ...extra, steps };
}

export interface RunResult {
  events: RunEvent[];
  summary: RunSummary;
  host: FakeHost;
  /** Compact event trace, e.g. ['start:a', 'log:a:stdout:hi', 'end:a:success', 'run:success']. */
  trace: string[];
  /** Output of the latest step-end for a block. */
  output(stepId: string): StepOutput | undefined;
  /** Error of the latest step-end for a block. */
  error(stepId: string): string | undefined;
}

/** Deterministic clock: every call advances by 10 ms. */
export function fakeClock(start = 1_000): () => number {
  let t = start;
  return () => {
    t += 10;
    return t;
  };
}

export function traceOf(events: RunEvent[]): string[] {
  return events.map((e) => {
    switch (e.type) {
      case 'run-start':
        return 'run-start';
      case 'step-start':
        return `start:${e.stepId}`;
      case 'step-log':
        return `log:${e.stepId}:${e.stream}:${e.text}`;
      case 'step-end':
        return `end:${e.stepId}:${e.status}`;
      case 'loop-iteration':
        return `iter:${e.stepId}:${e.iteration}`;
      case 'run-end':
        return `run:${e.status}`;
    }
  });
}

export async function run(
  wf: Workflow,
  options: Partial<RunOptions> & { host?: FakeHost } = {},
): Promise<RunResult> {
  const host = options.host ?? new FakeHost();
  const gen = runWorkflow(wf, {
    runId: 'run-1',
    inputs: {},
    agents: {},
    workspaceRoot: '/ws',
    now: fakeClock(),
    ...options,
    host,
  });
  const events: RunEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  const summary = next.value;
  const ends = events.filter((e): e is Extract<RunEvent, { type: 'step-end' }> => e.type === 'step-end');
  const last = (id: string) => ends.filter((e) => e.stepId === id).at(-1);
  return {
    events,
    summary,
    host,
    trace: traceOf(events),
    output: (id) => last(id)?.output,
    error: (id) => last(id)?.error,
  };
}

export function eventsOfType<T extends RunEvent['type']>(
  events: RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
}
