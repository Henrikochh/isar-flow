export const DEFAULT_MAX_ITERATIONS = 5;
const MAX_ITERATIONS_LIMIT = 100;

/** A loop's iteration limit. Schema validation guarantees 1–100; this keeps runs finite even for unvalidated input. */
export function iterationLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEFAULT_MAX_ITERATIONS;
  return Math.min(Math.floor(value), MAX_ITERATIONS_LIMIT);
}
