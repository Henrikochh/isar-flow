/**
 * The "JSON fields" editor works on compact output shapes (`{ approved: boolean, issues: "string[]" }`).
 * Rows keep specs they cannot represent (e.g. `integer` or nested objects) untouched until the user picks a
 * different type, so editing one row never rewrites another.
 */
import { isJsonSchema, type OutputShape } from '@isar-flow/core';
import { isRecord } from './model';

export type FieldKind = 'string' | 'number' | 'boolean' | 'list' | 'object';

export const FIELD_KINDS: readonly { value: FieldKind; label: string; spec: string }[] = [
  { value: 'string', label: 'Text', spec: 'string' },
  { value: 'number', label: 'Number', spec: 'number' },
  { value: 'boolean', label: 'Yes/no', spec: 'boolean' },
  { value: 'list', label: 'List of text', spec: 'string[]' },
  { value: 'object', label: 'Object', spec: 'object' },
];

const KIND_BY_SPEC = new Map(FIELD_KINDS.map((k) => [k.spec, k.value]));

export interface ShapeRow {
  key: string;
  /** 'custom' when the spec is none of the five simple kinds. */
  kind: FieldKind | 'custom';
  optional: boolean;
  /** Spec without the optional marker; written back as is. */
  spec: unknown;
}

/** Short text for a spec the editor cannot represent, shown in the type select. */
export function describeSpec(spec: unknown): string {
  if (typeof spec === 'string') return spec;
  if (Array.isArray(spec)) return 'List';
  if (isRecord(spec)) return 'Nested fields';
  return JSON.stringify(spec) ?? 'Unknown';
}

/** Rows for a compact shape; null for a full JSON Schema or a value that is not an object. */
export function shapeToRows(shape: unknown): ShapeRow[] | null {
  if (shape === undefined) return [];
  if (!isRecord(shape) || isJsonSchema(shape as OutputShape)) return null;
  return Object.entries(shape).map(([rawKey, rawSpec]) => {
    const keyOptional = rawKey.length > 1 && rawKey.endsWith('?');
    const key = keyOptional ? rawKey.slice(0, -1) : rawKey;
    let spec = rawSpec;
    let specOptional = false;
    if (typeof rawSpec === 'string') {
      const trimmed = rawSpec.trim();
      specOptional = trimmed.endsWith('?');
      spec = specOptional ? trimmed.slice(0, -1).trim() : trimmed;
    }
    const kind = typeof spec === 'string' ? (KIND_BY_SPEC.get(spec) ?? 'custom') : 'custom';
    return { key, kind, optional: keyOptional || specOptional, spec };
  });
}

/** Compact shape for rows; optional fields are written as `key?`. */
export function rowsToShape(rows: readonly ShapeRow[]): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const row of rows) shape[row.optional ? `${row.key}?` : row.key] = row.spec;
  return shape;
}

export function withKind(row: ShapeRow, kind: FieldKind): ShapeRow {
  const spec = FIELD_KINDS.find((k) => k.value === kind)?.spec ?? 'string';
  return { ...row, kind, spec };
}

/** Problem per row (empty or duplicate names), undefined when the row is fine. */
export function rowProblems(rows: readonly ShapeRow[]): (string | undefined)[] {
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.key.trim(), (seen.get(row.key.trim()) ?? 0) + 1);
  return rows.map((row) => {
    const key = row.key.trim();
    if (key === '') return 'Enter a field name.';
    if (key.endsWith('?')) return 'Use the Optional checkbox instead of a trailing ?.';
    if ((seen.get(key) ?? 0) > 1) return `The field '${key}' is listed twice.`;
    return undefined;
  });
}
