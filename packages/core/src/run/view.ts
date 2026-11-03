import type { LogStream, RunEvent, Usage } from '../engine/types';
import { usageOfOutput } from '../engine/usage';
import type { RunRecordSummary } from '../protocol';
import { addExecution, blockRunMetrics } from './metrics';
import type { RunView, StepRunView } from './types';

/** Log entries kept per block; older ones are dropped. */
export const MAX_LOG_LINES = 2000;

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function createRunView(
  runId: string,
  workflowName: string,
  startedAt: number,
  inputs: Record<string, unknown> = {},
): RunView {
  return { runId, workflowName, status: 'running', startedAt, inputs, usage: { ...ZERO_USAGE }, steps: {} };
}

function emptyStep(): StepRunView {
  return { status: 'pending', executions: 0, logs: [] };
}

function withStep(view: RunView, stepId: string, update: (step: StepRunView) => StepRunView): RunView {
  return { ...view, steps: { ...view.steps, [stepId]: update(view.steps[stepId] ?? emptyStep()) } };
}

/** The innermost running block: blocks enter `steps` in first-start order, so descendants come after ancestors. */
function lastRunning(steps: Record<string, StepRunView>): string | undefined {
  let active: string | undefined;
  for (const [id, step] of Object.entries(steps)) if (step.status === 'running') active = id;
  return active;
}

function withActive(view: RunView, activeStepId: string | undefined): RunView {
  const { activeStepId: _previous, ...rest } = view;
  return activeStepId === undefined ? rest : { ...rest, activeStepId };
}

/** Splits text into lines that keep their trailing newline; the last piece may be unfinished. */
function splitKeepingNewlines(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
    parts.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/** Appends a chunk; an unfinished last line of the same stream is continued instead of starting a new entry. */
function appendLog(step: StepRunView, stream: LogStream, text: string): StepRunView {
  if (text === '') return step;
  const logs = step.logs.slice();
  const pieces = splitKeepingNewlines(text);
  const last = logs[logs.length - 1];
  if (last && last.stream === stream && !last.text.endsWith('\n')) {
    logs[logs.length - 1] = { stream, text: last.text + pieces.shift() };
  }
  for (const piece of pieces) logs.push({ stream, text: piece });
  if (logs.length <= MAX_LOG_LINES) return { ...step, logs };
  return { ...step, logs: logs.slice(logs.length - MAX_LOG_LINES), logsTruncated: true };
}

function startStep(previous: StepRunView, event: Extract<RunEvent, { type: 'step-start' }>): StepRunView {
  return {
    status: 'running',
    executions: previous.executions + 1,
    ...(event.iteration !== undefined && { iteration: event.iteration }),
    ...(event.detail !== undefined && { detail: event.detail }),
    startedAt: event.at,
    logs: [],
    ...(previous.metrics && { metrics: previous.metrics }),
  };
}

function endStep(previous: StepRunView, event: Extract<RunEvent, { type: 'step-end' }>): StepRunView {
  const { error: _previousError, ...rest } = previous;
  return {
    ...rest,
    status: event.status,
    output: event.output,
    durationMs: event.durationMs,
    ...(event.error !== undefined && { error: event.error }),
    ...(event.status !== 'skipped' && {
      metrics: addExecution(previous.metrics, event.durationMs, event.output),
    }),
  };
}

/** Applies one engine event to a run view. Pure: never mutates its inputs. */
export function reduceRunEvent(view: RunView | null, event: RunEvent): RunView {
  if (event.type === 'run-start') {
    return createRunView(event.runId, event.workflowName, event.startedAt, event.inputs);
  }
  const current = view ?? createRunView(event.runId, '', 'at' in event ? event.at : 0);
  if (current.runId !== event.runId) return current;

  switch (event.type) {
    case 'step-start':
      return withActive(
        withStep(current, event.stepId, (step) => startStep(step, event)),
        event.stepId,
      );
    case 'step-log':
      return withStep(current, event.stepId, (step) => appendLog(step, event.stream, event.text));
    case 'step-end': {
      let next = withStep(current, event.stepId, (step) => endStep(step, event));
      const usage = usageOfOutput(event.output);
      if (usage) {
        next = {
          ...next,
          usage: {
            inputTokens: next.usage.inputTokens + usage.inputTokens,
            outputTokens: next.usage.outputTokens + usage.outputTokens,
          },
        };
      }
      return withActive(next, lastRunning(next.steps));
    }
    case 'loop-iteration':
      return withStep(current, event.stepId, (step) => ({
        ...step,
        loop: { iteration: event.iteration, maxIterations: event.maxIterations },
      }));
    case 'run-end': {
      const steps: Record<string, StepRunView> = {};
      for (const [id, step] of Object.entries(current.steps)) {
        steps[id] = step.status === 'running' ? { ...step, status: 'cancelled' } : step;
      }
      const { error: _previousError, ...rest } = withActive(current, undefined);
      return {
        ...rest,
        status: event.status,
        durationMs: event.durationMs,
        usage: { ...event.usage },
        ...(event.error !== undefined && { error: event.error }),
        steps,
      };
    }
  }
}

/** Compact record of a run for history lists (it lives in the history index, so no text or logs). */
export function runRecordSummary(view: RunView, workflowUri: string): RunRecordSummary {
  const blocks = blockRunMetrics(view.steps);
  return {
    runId: view.runId,
    workflowUri,
    workflowName: view.workflowName,
    status: view.status,
    startedAt: view.startedAt,
    ...(view.durationMs !== undefined && { durationMs: view.durationMs }),
    ...(view.error !== undefined && { error: view.error }),
    usage: { ...view.usage },
    ...(Object.keys(blocks).length > 0 && { blocks }),
  };
}
