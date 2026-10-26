import { describe, expect, it } from 'vitest';
import {
  expressionCondition,
  expressionProblem,
  expressionText,
  expressionToRules,
  isNestedCondition,
  parseOperand,
  readRules,
  rulesToExpression,
  singleTemplate,
  valueFromText,
  valueKey,
  writeRules,
} from '../../../src/views/workflow/inspector/conditionModel';

describe('templates', () => {
  it('finds a string that is exactly one template', () => {
    expect(singleTemplate('${{ steps.tests.exitCode }}')).toBe('steps.tests.exitCode');
    expect(singleTemplate('  ${{ a }} ')).toBe('a');
    expect(singleTemplate('code ${{ a }}')).toBeNull();
    expect(singleTemplate('${{ a }}${{ b }}')).toBeNull();
    expect(singleTemplate('${{ broken')).toBeNull();
  });

  it('round-trips the expression editor text', () => {
    expect(expressionText('${{ steps.a.b == 1 }}')).toBe('steps.a.b == 1');
    expect(expressionCondition('steps.a.b == 1')).toBe('${{ steps.a.b == 1 }}');
    expect(expressionCondition('${{ a }} and ${{ b }}')).toBe('${{ a }} and ${{ b }}');
  });

  it('normalizes value keys so picker options match', () => {
    expect(valueKey('${{steps.tests.exitCode}}')).toBe('${{ steps.tests.exitCode }}');
    expect(valueKey('plain')).toBe('plain');
    expect(valueKey(3)).toBe('3');
  });

  it('wraps references typed into the value picker', () => {
    expect(valueFromText('steps.tests.stdout')).toBe('${{ steps.tests.stdout }}');
    expect(valueFromText('${{ inputs.mode }}')).toBe('${{ inputs.mode }}');
    expect(valueFromText('hello world')).toBe('hello world');
    expect(valueFromText('42')).toBe('42');
  });
});

describe('operands', () => {
  it('parses numbers and booleans, keeps other text', () => {
    expect(parseOperand('0')).toBe(0);
    expect(parseOperand('-2.5')).toBe(-2.5);
    expect(parseOperand('true')).toBe(true);
    expect(parseOperand('false')).toBe(false);
    expect(parseOperand('CHANGES')).toBe('CHANGES');
    expect(parseOperand('1.2.3')).toBe('1.2.3');
  });
});

describe('expressionProblem', () => {
  it('accepts valid expressions and templates', () => {
    expect(expressionProblem('steps.tests.exitCode != 0 && !steps.review.json.approved')).toBeNull();
    expect(expressionProblem('${{ contains(steps.review.text, "OK") }}')).toBeNull();
  });

  it('reports syntax errors with a column', () => {
    expect(expressionProblem('steps.tests.exitCode ==')).toMatch(/column/);
  });

  it('reports unknown functions and empty text', () => {
    expect(expressionProblem('frobnicate(1)')).toMatch(/Unknown function 'frobnicate'/);
    expect(expressionProblem('   ')).toMatch(/Enter an expression/);
  });
});

describe('readRules / writeRules', () => {
  const exit = { value: '${{ steps.tests.exitCode }}', op: 'eq' as const, to: 0 };
  const approved = { value: '${{ steps.review.json.approved }}', op: 'isTrue' as const };

  it('reads one group of comparisons', () => {
    expect(readRules({ all: [exit, approved] })).toEqual({ combinator: 'all', rules: [exit, approved] });
    expect(readRules({ any: [exit] })).toEqual({ combinator: 'any', rules: [exit] });
    expect(readRules(exit)).toEqual({ combinator: 'all', rules: [exit] });
    expect(readRules(undefined)).toEqual({ combinator: 'all', rules: [] });
  });

  it('flags nested groups and not', () => {
    expect(readRules({ all: [exit, { any: [approved] }] })).toBeNull();
    expect(isNestedCondition({ all: [exit, { any: [approved] }] })).toBe(true);
    expect(isNestedCondition({ not: exit })).toBe(true);
    expect(isNestedCondition({ all: [exit] })).toBe(false);
    expect(isNestedCondition('${{ true }}')).toBe(false);
  });

  it('writes a single rule without a group and drops operands that are not needed', () => {
    expect(writeRules({ combinator: 'any', rules: [exit] })).toEqual(exit);
    expect(writeRules({ combinator: 'any', rules: [exit, { ...approved, to: 'x' }] })).toEqual({ any: [exit, approved] });
  });

  it('keeps ignoreCase only for text operators', () => {
    const rule = { value: '${{ steps.review.text }}', op: 'contains' as const, to: 'changes', ignoreCase: true };
    expect(writeRules({ combinator: 'all', rules: [rule] })).toEqual(rule);
    expect(writeRules({ combinator: 'all', rules: [{ ...exit, op: 'gt', ignoreCase: true }] })).toEqual({ ...exit, op: 'gt' });
  });
});

describe('expressionToRules', () => {
  it('converts an or-chain of comparisons and negations', () => {
    expect(expressionToRules('${{ !steps.review.json.approved || steps.tests.exitCode != 0 }}')).toEqual({
      combinator: 'any',
      rules: [
        { value: '${{ steps.review.json.approved }}', op: 'isFalse' },
        { value: '${{ steps.tests.exitCode }}', op: 'neq', to: 0 },
      ],
    });
  });

  it('converts function calls, mirrored comparisons and plain references', () => {
    expect(expressionToRules("contains(steps.review.text, 'LGTM', true) && 3 > loop.iteration && inputs.force")).toEqual({
      combinator: 'all',
      rules: [
        { value: '${{ steps.review.text }}', op: 'contains', to: 'LGTM', ignoreCase: true },
        { value: '${{ loop.iteration }}', op: 'lt', to: 3 },
        { value: '${{ inputs.force }}', op: 'isTrue' },
      ],
    });
    expect(expressionToRules("!matches(steps.a.stdout, 'err', 'i')")).toEqual({
      combinator: 'all',
      rules: [{ value: '${{ steps.a.stdout }}', op: 'notMatches', to: 'err', ignoreCase: true }],
    });
  });

  it('treats ${{ true }} as an empty rule set', () => {
    expect(expressionToRules('${{ true }}')).toEqual({ combinator: 'all', rules: [] });
  });

  it('gives up on mixed and/or, arithmetic and broken text', () => {
    expect(expressionToRules('a && b || c')).toBeNull();
    expect(expressionToRules('a + 1')).toBeNull();
    expect(expressionToRules('a ==')).toBeNull();
    expect(expressionToRules('x ${{ a }}')).toBeNull();
    expect(expressionToRules('a == null')).toBeNull();
  });
});

describe('rulesToExpression', () => {
  it('builds an equivalent expression', () => {
    expect(
      rulesToExpression({
        combinator: 'all',
        rules: [
          { value: '${{ steps.tests.exitCode }}', op: 'eq', to: 0 },
          { value: '${{ steps.review.json.approved }}', op: 'isTrue' },
        ],
      }),
    ).toBe('steps.tests.exitCode == 0 && steps.review.json.approved');
    expect(
      rulesToExpression({
        combinator: 'any',
        rules: [
          { value: '${{ steps.review.text }}', op: 'notContains', to: "it's fine", ignoreCase: true },
          { value: '${{ steps.a.b }}', op: 'isFalse' },
        ],
      }),
    ).toBe("!contains(steps.review.text, 'it\\'s fine', true) || !steps.a.b");
  });

  it('round-trips through expressionToRules', () => {
    const set = {
      combinator: 'any' as const,
      rules: [
        { value: '${{ steps.tests.exitCode }}', op: 'gte' as const, to: 2 },
        { value: '${{ steps.review.text }}', op: 'startsWith' as const, to: 'OK' },
      ],
    };
    expect(expressionToRules(rulesToExpression(set) ?? '')).toEqual(set);
  });

  it('parenthesizes complex values', () => {
    expect(rulesToExpression({ combinator: 'all', rules: [{ value: '${{ a || b }}', op: 'isFalse' }] })).toBe('!(a || b)');
  });
});
