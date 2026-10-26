import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  checkJsonShape,
  describeOutputShape,
  extractJson,
  isJsonSchema,
  shapeToJsonSchema,
  validateOutputShape,
} from '../../src/agent';
import { extractJsonMatching } from '../../src/agent/json';

describe('extractJson', () => {
  it('parses plain JSON values', () => {
    expect(extractJson('{"approved": true}')).toEqual({ approved: true });
    expect(extractJson('  [1, 2]\n')).toEqual([1, 2]);
    expect(extractJson('42')).toBe(42);
    expect(extractJson('﻿{"a":1}')).toEqual({ a: 1 });
  });

  it('reads fenced code blocks', () => {
    expect(extractJson('Here you go:\n```json\n{"approved": false, "issues": ["x"]}\n```\nThanks!')).toEqual({
      approved: false,
      issues: ['x'],
    });
    expect(extractJson('```\n[{"a": 1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJson('```JSON\r\n{"a": 1}\r\n```')).toEqual({ a: 1 });
  });

  it('prefers a json-labelled fence over other fences', () => {
    const text = 'Example:\n```ts\n[1]\n```\nAnswer:\n```json\n{"a": 2}\n```';
    expect(extractJson(text)).toEqual({ a: 2 });
  });

  it('finds the first balanced object or array inside prose', () => {
    expect(extractJson('Sure! {"approved": true, "note": "use {braces} and ]"} Hope that helps.')).toEqual({
      approved: true,
      note: 'use {braces} and ]',
    });
    expect(extractJson('The list [see below] is: ["a", "b"]')).toEqual(['a', 'b']);
    expect(extractJson('Escapes {"q": "say \\"hi\\" }"} done')).toEqual({ q: 'say "hi" }' });
    expect(extractJson('Unclosed { here, but {"ok": 1}')).toEqual({ ok: 1 });
  });

  it('handles a fence that was never closed', () => {
    expect(extractJson('```json\n{"a": [1, 2]}')).toEqual({ a: [1, 2] });
  });

  it('throws a clear error when there is no JSON', () => {
    expect(() => extractJson('I approve this change.')).toThrow(/does not contain a JSON object or array/);
    expect(() => extractJson('')).toThrow(/does not contain a JSON object or array/);
  });

  it('reports the parse error when JSON-like text is malformed', () => {
    expect(() => extractJson('```json\n{approved: true}\n```')).toThrow(/not valid JSON: .+/);
    expect(() => extractJson('Result: {"a": 1,}')).toThrow(/not valid JSON/);
  });

  it('ignores a leading reasoning block, even when it contains draft JSON', () => {
    expect(extractJson('<think>Draft: {"approved": true}. No, wait.</think>\n{"approved": false}')).toEqual({
      approved: false,
    });
    expect(extractJson('<think>\nplan\n</think>\r\n```json\r\n[1]\r\n```')).toEqual([1]);
    expect(() => extractJson('<think>{"a": 1}</think>')).toThrow(/does not contain a JSON object or array/);
  });

  it('keeps reasoning tags that are part of the JSON itself', () => {
    expect(extractJson('{"note": "<think>x</think>"}')).toEqual({ note: '<think>x</think>' });
  });

  it('stays fast on many unbalanced brackets', () => {
    const text = '{'.repeat(50_000) + ' {"ok": true}';
    const started = Date.now();
    try {
      extractJson(text);
    } catch {
      // Giving up is fine here; hanging is not.
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('extractJsonMatching', () => {
  const shape = { approved: 'boolean', issues: 'string[]' };

  it('skips bracketed prose such as checkboxes and citations that does not fit the shape', () => {
    const checklist = 'Checklist:\n- [x] tests\n- [ ] docs\n\n{"approved": true, "issues": []}';
    expect(extractJsonMatching(checklist, shape)).toEqual({
      value: { approved: true, issues: [] },
      problems: [],
    });
    expect(extractJsonMatching('As noted in [1]: {"approved": false, "issues": ["x"]}', shape)).toEqual({
      value: { approved: false, issues: ['x'] },
      problems: [],
    });
  });

  it('prefers a later fenced block that fits over an earlier one that does not', () => {
    const text =
      'Example:\n```json\n{"approved": "maybe"}\n```\nAnswer:\n```json\n{"approved": true, "issues": []}\n```';
    expect(extractJsonMatching(text, shape).value).toEqual({ approved: true, issues: [] });
  });

  it('returns the closest candidate with its problems when nothing fits', () => {
    expect(extractJsonMatching('- [ ] docs\n{"approved": "yes", "issues": []}', shape)).toEqual({
      value: { approved: 'yes', issues: [] },
      problems: ['approved: expected boolean, got string "yes"'],
    });
  });

  it('never picks a value nested inside the answer, even when it fits better', () => {
    expect(extractJsonMatching('Result: {"wrapper": {"b": 1}} done', { b: 'number' })).toEqual({
      value: { wrapper: { b: 1 } },
      problems: ['b: missing (expected number)'],
    });
    expect(extractJsonMatching('{"wrapper": {"b": 1}}', { b: 'number' }).value).toEqual({
      wrapper: { b: 1 },
    });
  });

  it('throws like extractJson when there is no JSON at all', () => {
    expect(() => extractJsonMatching('I approve.', shape)).toThrow(/does not contain a JSON object or array/);
  });
});

describe('isJsonSchema', () => {
  it('detects full JSON Schemas', () => {
    expect(isJsonSchema({ type: 'object', properties: { a: { type: 'string' } } })).toBe(true);
    expect(isJsonSchema({ properties: { a: { type: 'string' } } })).toBe(true);
    expect(isJsonSchema({ type: 'array', items: { type: 'string' } })).toBe(true);
    expect(isJsonSchema({ type: ['string', 'null'] })).toBe(true);
  });

  it('treats other objects as compact shapes', () => {
    expect(isJsonSchema({ approved: 'boolean', issues: 'string[]' })).toBe(false);
    expect(isJsonSchema({ type: 'string', severity: 'number' })).toBe(false);
    expect(isJsonSchema({ properties: 'string[]' })).toBe(false);
  });
});

describe('checkJsonShape with compact shapes', () => {
  const shape = { approved: 'boolean', issues: 'string[]', score: 'number?', meta: { author: 'string' } };

  it('accepts matching values and extra keys', () => {
    expect(checkJsonShape({ approved: true, issues: [], meta: { author: 'a' }, extra: 1 }, shape)).toEqual(
      [],
    );
    expect(
      checkJsonShape({ approved: false, issues: ['x'], score: 3, meta: { author: 'a' } }, shape),
    ).toEqual([]);
  });

  it('accepts null or missing optional keys', () => {
    expect(checkJsonShape({ approved: true, issues: [], score: null, meta: { author: 'a' } }, shape)).toEqual(
      [],
    );
  });

  it('accepts null for optional keys given as an enum or with several types', () => {
    const optional = {
      'verdict?': { type: 'string', enum: ['approve', 'reject'] },
      'size?': { type: ['string', 'number'] },
    };
    expect(checkJsonShape({ verdict: null, size: null }, optional)).toEqual([]);
    expect(checkJsonShape({ verdict: 'maybe' }, optional)).toEqual([
      'verdict: expected one of "approve", "reject", null, got string "maybe"',
    ]);
    expect(shapeToJsonSchema(optional)).toEqual({
      type: 'object',
      properties: {
        verdict: { type: ['string', 'null'], enum: ['approve', 'reject', null] },
        size: { type: ['string', 'number', 'null'] },
      },
    });
  });

  it('reports missing keys and wrong types with paths', () => {
    expect(checkJsonShape({ issues: ['ok', 3], score: 'high', meta: {} }, shape)).toEqual([
      'approved: missing (expected boolean)',
      'issues[1]: expected string, got number 3',
      'score: expected number or null, got string "high"',
      'meta.author: missing (expected string)',
    ]);
  });

  it('reports a wrong root type', () => {
    expect(checkJsonShape([1], { a: 'string' })).toEqual(['expected object, got array']);
    expect(checkJsonShape(null, { a: 'string' })).toEqual(['expected object, got null']);
  });

  it('supports every type name', () => {
    const all = { s: 'string', n: 'number', i: 'integer', b: 'boolean', o: 'object', a: 'array', x: 'any' };
    expect(checkJsonShape({ s: '', n: 1.5, i: 2, b: false, o: {}, a: [], x: null }, all)).toEqual([]);
    expect(checkJsonShape({ s: 1, n: '1', i: 1.5, b: 'true', o: [], a: {}, x: 0 }, all)).toEqual([
      's: expected string, got number 1',
      'n: expected number, got string "1"',
      'i: expected integer, got number 1.5',
      'b: expected boolean, got string "true"',
      'o: expected object, got array',
      'a: expected array, got object',
    ]);
  });

  it('supports optional keys marked on the key, nested lists and one-element list shapes', () => {
    const nested = {
      'notes?': 'string',
      matrix: 'number[][]',
      findings: [{ file: 'string', line: 'integer' }],
    };
    expect(checkJsonShape({ matrix: [[1], []], findings: [{ file: 'a', line: 1 }] }, nested)).toEqual([]);
    expect(checkJsonShape({ notes: 1, matrix: [[1, 'x']], findings: [{ file: 'a' }] }, nested)).toEqual([
      'notes: expected string or null, got number 1',
      'matrix[0][1]: expected number, got string "x"',
      'findings[0].line: missing (expected integer)',
    ]);
  });

  it('quotes keys that are not identifiers', () => {
    expect(checkJsonShape({}, { 'file name': 'string' })).toEqual([
      '["file name"]: missing (expected string)',
    ]);
  });

  it('includes problems of an invalid shape instead of passing silently', () => {
    expect(checkJsonShape({ a: 1 }, { a: 'strng' })).toEqual([
      'a: unknown type "strng". Use string, number, integer, boolean, object, array or any; add [] for a list and ? for an optional key.',
    ]);
  });

  it('truncates long values in problems', () => {
    const [problem] = checkJsonShape({ a: 'x'.repeat(100) }, { a: 'number' });
    expect(problem.length).toBeLessThan(80);
  });
});

describe('checkJsonShape with JSON Schema', () => {
  const schema = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'reject'] },
      issues: {
        type: 'array',
        items: { type: 'object', properties: { line: { type: 'integer' } }, required: ['line'] },
      },
      note: { type: ['string', 'null'] },
    },
    required: ['verdict'],
  };

  it('accepts valid values', () => {
    expect(checkJsonShape({ verdict: 'approve', issues: [{ line: 3 }], note: null }, schema)).toEqual([]);
  });

  it('checks type, required, properties, items and enum', () => {
    expect(checkJsonShape({ verdict: 'maybe', issues: [{}, { line: 'x' }], note: 5 }, schema)).toEqual([
      'verdict: expected one of "approve", "reject", got string "maybe"',
      'issues[0].line: missing (expected integer)',
      'issues[1].line: expected integer, got string "x"',
      'note: expected string or null, got number 5',
    ]);
    expect(checkJsonShape({}, schema)).toEqual(['verdict: missing (expected string)']);
    expect(checkJsonShape('text', schema)).toEqual(['expected object, got string "text"']);
  });

  it('accepts anything for an empty schema and ignores unsupported keywords', () => {
    expect(checkJsonShape({ any: 1 }, { type: 'object', minProperties: 5 })).toEqual([]);
  });

  it('limits the number of problems', () => {
    const many = Array.from({ length: 50 }, () => 1);
    const problems = checkJsonShape(many, { type: 'array', items: { type: 'string' } });
    expect(problems).toHaveLength(21);
    expect(problems[20]).toBe('…and 30 more problems');
  });
});

describe('shapeToJsonSchema', () => {
  it('converts compact shapes', () => {
    expect(
      shapeToJsonSchema({
        approved: 'boolean',
        issues: 'string[]',
        score: 'number?',
        'meta?': { author: 'string', tags: 'any[]' },
        findings: [{ line: 'integer' }],
        raw: 'any',
      }),
    ).toEqual({
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        issues: { type: 'array', items: { type: 'string' } },
        score: { type: ['number', 'null'] },
        meta: {
          type: ['object', 'null'],
          properties: { author: { type: 'string' }, tags: { type: 'array', items: {} } },
          required: ['author', 'tags'],
        },
        findings: {
          type: 'array',
          items: { type: 'object', properties: { line: { type: 'integer' } }, required: ['line'] },
        },
        raw: {},
      },
      required: ['approved', 'issues', 'findings', 'raw'],
    });
  });

  it('returns full JSON Schemas unchanged', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(shapeToJsonSchema(schema)).toBe(schema);
  });

  it('keeps nested JSON Schemas inside compact shapes', () => {
    expect(shapeToJsonSchema({ verdict: { type: 'string', enum: ['yes', 'no'] } })).toEqual({
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['yes', 'no'] } },
      required: ['verdict'],
    });
  });
});

describe('validateOutputShape', () => {
  it('accepts valid compact shapes and any JSON Schema', () => {
    expect(validateOutputShape({ a: 'string?', b: ['number'], c: { d: 'any[]' } })).toEqual([]);
    expect(validateOutputShape({ type: 'object', properties: {} })).toEqual([]);
  });

  it('reports compact types written inside a JSON Schema', () => {
    const mixed = {
      type: 'object',
      properties: { approved: 'boolean', issues: 'string[]', meta: { type: 'object', properties: { n: 3 } } },
    };
    expect(validateOutputShape(mixed)).toEqual([
      'approved: "boolean" is a compact type, but this schema is a JSON Schema (it has "type" or "properties"). Write {"type":"boolean"} instead, or use the compact form throughout.',
      'issues: "string[]" is a compact type, but this schema is a JSON Schema (it has "type" or "properties"). Write {"type":"array","items":{"type":"string"}} instead, or use the compact form throughout.',
      'meta.n: expected a JSON Schema object such as {"type":"string"}, got number 3.',
    ]);
    // Validation must not silently accept anything for such a schema.
    expect(checkJsonShape({ approved: 'yes', issues: 5, meta: {} }, mixed).length).toBeGreaterThan(0);
  });

  it('reports unknown types inside JSON Schemas, also nested in compact shapes', () => {
    expect(validateOutputShape({ type: 'object', properties: { a: { type: 'bool' } } })).toEqual([
      'a: unknown JSON Schema type "bool". Use string, number, integer, boolean, object, array or null.',
    ]);
    expect(validateOutputShape({ list: { type: 'array', items: { type: ['string', 'text'] } } })).toEqual([
      'list[]: unknown JSON Schema type "text". Use string, number, integer, boolean, object, array or null.',
    ]);
  });

  it('accepts boolean subschemas and the tool parameter schemas', () => {
    expect(
      validateOutputShape({ type: 'object', properties: { a: true, b: { type: 'array', items: {} } } }),
    ).toEqual([]);
    for (const tool of Object.values(BUILTIN_TOOLS)) expect(validateOutputShape(tool.parameters)).toEqual([]);
  });

  it('reports unknown types and unsupported values', () => {
    expect(validateOutputShape({ a: 'bool', b: 5, c: ['string', 'number'] })).toEqual([
      'a: unknown type "bool". Use string, number, integer, boolean, object, array or any; add [] for a list and ? for an optional key.',
      'b: expected a type name like "string", a nested object or a one-element list like ["string"].',
      'c: expected a type name like "string", a nested object or a one-element list like ["string"].',
    ]);
  });
});

describe('describeOutputShape', () => {
  it('renders compact shapes like TypeScript', () => {
    expect(
      describeOutputShape({
        approved: 'boolean',
        issues: 'string[]',
        'notes?': 'string',
        items: [{ id: 'number?' }],
      }),
    ).toBe(
      [
        '{',
        '  "approved": boolean,',
        '  "issues": string[],',
        '  "notes"?: string,',
        '  "items": {',
        '    "id"?: number',
        '  }[]',
        '}',
      ].join('\n'),
    );
  });

  it('prints JSON Schemas as JSON', () => {
    expect(describeOutputShape({ type: 'array', items: { type: 'string' } })).toBe(
      JSON.stringify({ type: 'array', items: { type: 'string' } }, null, 2),
    );
  });
});
