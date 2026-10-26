import { describe, expect, it } from 'vitest';
import { findTemplateExpressions, renderDeep, renderTemplate, stringifyValue } from '../../src/expr';

const ctx = {
  inputs: { task: 'Add login' },
  steps: { tests: { exitCode: 0 }, review: { json: { approved: false, issues: ['x'] } } },
};

describe('findTemplateExpressions', () => {
  it('finds all templates with offsets', () => {
    const text = 'A ${{ inputs.task }} and ${{steps.tests.exitCode}}';
    expect(findTemplateExpressions(text)).toEqual([
      { expr: 'inputs.task', start: 2, end: 20 },
      { expr: 'steps.tests.exitCode', start: 25, end: 50 },
    ]);
  });

  it('ignores closing braces inside string literals', () => {
    const text = "${{ contains(inputs.task, '}}') }}";
    expect(findTemplateExpressions(text)).toEqual([
      { expr: "contains(inputs.task, '}}')", start: 0, end: text.length },
    ]);
  });

  it('throws on unterminated templates', () => {
    expect(() => findTemplateExpressions('x ${{ inputs.task')).toThrow(/Unterminated/);
  });
});

describe('renderTemplate', () => {
  it('returns non-template strings unchanged', () => {
    expect(renderTemplate('plain text', ctx)).toBe('plain text');
  });

  it('returns the raw value when the whole string is one template', () => {
    expect(renderTemplate('${{ steps.tests.exitCode }}', ctx)).toBe(0);
    expect(renderTemplate('${{ steps.review.json.approved }}', ctx)).toBe(false);
    expect(renderTemplate('  ${{ steps.tests.exitCode }}  ', ctx)).toBe(0);
  });

  it('interpolates into surrounding text', () => {
    expect(renderTemplate('Task: ${{ inputs.task }} (exit ${{ steps.tests.exitCode }})', ctx)).toBe(
      'Task: Add login (exit 0)',
    );
  });

  it('stringifies objects as pretty JSON and null as empty', () => {
    expect(renderTemplate('Issues: ${{ steps.review.json.issues }}', ctx)).toBe('Issues: [\n  "x"\n]');
    expect(renderTemplate('[${{ steps.missing }}]', ctx)).toBe('[]');
  });

  it('passes through non-strings', () => {
    expect(renderTemplate(5 as unknown as string, ctx)).toBe(5);
  });
});

describe('renderDeep', () => {
  it('renders templates in nested objects and arrays', () => {
    expect(renderDeep({ a: '${{ inputs.task }}', b: ['${{ steps.tests.exitCode }}', 1] }, ctx)).toEqual({
      a: 'Add login',
      b: [0, 1],
    });
  });
});

describe('stringifyValue', () => {
  it('formats values for text output', () => {
    expect(stringifyValue('x')).toBe('x');
    expect(stringifyValue(1)).toBe('1');
    expect(stringifyValue(true)).toBe('true');
    expect(stringifyValue(undefined)).toBe('');
    expect(stringifyValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
