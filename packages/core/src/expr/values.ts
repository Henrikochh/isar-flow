/** Shared value semantics for expressions and conditions. */

export function isNumberLike(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
  return false;
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null || value === '') return 0;
  return Number(value);
}

/** Text form used for interpolation: objects become pretty JSON, null/undefined become ''. */
export function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return JSON.stringify(value, null, 2);
}

export function isTruthy(value: unknown): boolean {
  return Boolean(value);
}

export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'boolean' && typeof b === 'string') return String(a) === b.trim().toLowerCase();
  if (typeof b === 'boolean' && typeof a === 'string') return String(b) === a.trim().toLowerCase();
  if (isNumberLike(a) && isNumberLike(b)) return toNumber(a) === toNumber(b);
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Numeric comparison when both sides are number-like, otherwise string comparison. */
export function compareValues(a: unknown, b: unknown): number {
  if (isNumberLike(a) && isNumberLike(b)) return toNumber(a) - toNumber(b);
  const sa = stringifyValue(a);
  const sb = stringifyValue(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
