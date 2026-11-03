import type { LiveContext } from '../run/types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What the condition of an if or loop block evaluated to the last time in the run: an if's result; for an
 * `until` loop true when it ended on its condition and false when it hit its limit; for a `while` loop the
 * reverse. Undefined when the block has no condition, did not run, or ended otherwise (e.g. on a break).
 */
export function lastConditionResult(step: unknown, context: LiveContext): boolean | undefined {
  if (!isRecord(step) || typeof step.id !== 'string') return undefined;
  const output = Object.hasOwn(context.steps, step.id) ? context.steps[step.id] : undefined;
  if (!output) return undefined;
  if (step.type === 'if') return typeof output.result === 'boolean' ? output.result : undefined;
  if (step.type !== 'loop') return undefined;
  const hasUntil = step.until !== undefined;
  const hasWhile = step.while !== undefined;
  if (hasUntil === hasWhile) return undefined;
  if (output.exitReason === 'condition') return hasUntil;
  if (output.exitReason === 'maxIterations') return hasWhile;
  return undefined;
}
