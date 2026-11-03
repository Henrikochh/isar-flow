import type { SimulationResult } from '@isar-flow/core';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Values JSON can hold; `depth` stops at cyclic or absurdly deep data a webview message could carry. */
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

const STRING_FIELDS = ['output', 'text', 'comment'] as const;

/** Mocks from the webview: keeps the known fields with the right types and drops anything that is no result. */
export function cleanSimulationResults(results: unknown[]): SimulationResult[] {
  return results.flatMap((value): SimulationResult[] => {
    if (!isPlainObject(value)) return [];
    const result: SimulationResult = {};
    if (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode))
      result.exitCode = value.exitCode;
    for (const field of STRING_FIELDS) {
      const text = value[field];
      if (typeof text === 'string') result[field] = text;
    }
    if (Object.hasOwn(value, 'json') && isJsonValue(value.json)) result.json = value.json;
    if (typeof value.approved === 'boolean') result.approved = value.approved;
    if (typeof value.error === 'string' && value.error !== '') result.error = value.error;
    return [result];
  });
}
