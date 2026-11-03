import { copyData } from '../engine/mask';
import type { LiveContext, RunView } from '../run/types';

/** Longest text a live value shows; longer strings in a run's context are cut to this plus an ellipsis. */
export const LIVE_VALUE_MAX_CHARS = 2048;

const ELLIPSIS = '…';

/** First `max` characters, one less when the cut would split a surrogate pair. */
export function cutText(text: string, max: number = LIVE_VALUE_MAX_CHARS): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Text cut to what a live value shows, with an ellipsis when it was longer (isCutString detects it). */
export function cutString(text: string): string {
  return text.length > LIVE_VALUE_MAX_CHARS ? cutText(text) + ELLIPSIS : text;
}

/** True for a string that liveContext cut (its length gives it away; real text of that exact form is rare). */
export function isCutString(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.endsWith(ELLIPSIS) &&
    value.length >= LIVE_VALUE_MAX_CHARS &&
    value.length <= LIVE_VALUE_MAX_CHARS + 1
  );
}

/**
 * The expression context of a run for live values: inputs, block outputs, loop iterations and the recorded editor
 * and git values, long text cut.
 */
export function liveContext(run: RunView): LiveContext {
  const entries = Object.entries(run.steps);
  const steps = Object.fromEntries(
    entries.flatMap(([id, step]) => (step.output ? [[id, copyData(step.output, cutString)]] : [])),
  );
  const loops = Object.fromEntries(
    entries.flatMap(([id, step]) =>
      step.loop ? [[id, { iteration: step.loop.iteration, index: step.loop.iteration - 1 }]] : [],
    ),
  );
  const context = run.context;
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    status: run.status,
    ...(run.simulated !== undefined && { simulated: run.simulated }),
    inputs: copyData(run.inputs ?? {}, cutString),
    steps,
    loops,
    env: [...(context?.env ?? [])],
    secrets: [...(context?.secrets ?? [])],
    workflow: context ? { ...context.workflow } : { name: run.workflowName, file: '' },
    workspace: context ? { ...context.workspace } : { root: '' },
    ...(context?.editor && { editor: copyData(context.editor, cutString) }),
    ...(context?.git && { git: copyData(context.git, cutString) }),
  };
}
