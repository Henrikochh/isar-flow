import { describe, expect, it } from 'vitest';
import { rowProblems, rowsToShape, shapeToRows, withKind } from '../../../src/views/workflow/inspector/shapeRows';

describe('shapeRows', () => {
  it('reads compact shapes, including both optional markers', () => {
    expect(shapeToRows({ approved: 'boolean', issues: 'string[]', 'notes?': 'string', score: 'number?' })).toEqual([
      { key: 'approved', kind: 'boolean', optional: false, spec: 'boolean' },
      { key: 'issues', kind: 'list', optional: false, spec: 'string[]' },
      { key: 'notes', kind: 'string', optional: true, spec: 'string' },
      { key: 'score', kind: 'number', optional: true, spec: 'number' },
    ]);
  });

  it('keeps specs it cannot represent untouched', () => {
    const rows = shapeToRows({ count: 'integer', meta: { author: 'string' } });
    expect(rows?.map((r) => r.kind)).toEqual(['custom', 'custom']);
    expect(rowsToShape(rows ?? [])).toEqual({ count: 'integer', meta: { author: 'string' } });
  });

  it('returns null for full JSON Schemas', () => {
    expect(shapeToRows({ type: 'object', properties: { a: { type: 'string' } } })).toBeNull();
    expect(shapeToRows('string')).toBeNull();
    expect(shapeToRows(undefined)).toEqual([]);
  });

  it('writes optional fields with a key marker and changes kinds', () => {
    const [row] = shapeToRows({ summary: 'string?' }) ?? [];
    expect(rowsToShape([row])).toEqual({ 'summary?': 'string' });
    expect(rowsToShape([withKind({ ...row, optional: false }, 'list')])).toEqual({ summary: 'string[]' });
  });

  it('reports empty and duplicate names', () => {
    const base = { kind: 'string' as const, optional: false, spec: 'string' };
    expect(rowProblems([{ ...base, key: 'a' }, { ...base, key: '' }, { ...base, key: 'a' }])).toEqual([
      "The field 'a' is listed twice.",
      'Enter a field name.',
      "The field 'a' is listed twice.",
    ]);
  });
});
