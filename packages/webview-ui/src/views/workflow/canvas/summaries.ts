import { type Condition, describeCondition } from '@isar-flow/core';

/** describeCondition for lenient values: null when there is no usable condition. */
export function describeSafely(value: unknown): string | null {
  if (typeof value === 'string' && !value.trim()) return null;
  if (typeof value !== 'string') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    if (!['all', 'any', 'not', 'op'].some((k) => Object.hasOwn(value, k))) return null;
  }
  try {
    return describeCondition(value as Condition) || null;
  } catch {
    return typeof value === 'string' ? value : null;
  }
}

export interface LoopSummary {
  /** Plain words, e.g. "Repeat until". */
  lead: string;
  /** Condition text shown in code font, if any. */
  condition?: string;
}

export function loopSummary(step: Record<string, unknown>): LoopSummary {
  const until = describeSafely(step.until);
  if (until) return { lead: 'Repeat until', condition: until };
  const whileText = describeSafely(step.while);
  if (whileText) return { lead: 'Repeat while', condition: whileText };
  const max = step.maxIterations;
  if (typeof max === 'number' && max > 0) return { lead: max === 1 ? 'Run once' : `Repeat ${max} times` };
  return { lead: 'Repeat until the limit is reached' };
}
