import { describe, expect, it } from 'vitest';
import { CONDITION_OPS, type Condition, describeCondition, evaluateCondition } from '../src/conditions';

const ctx = {
  steps: {
    tests: { exitCode: 1, output: 'Tests: 3 failed\nFAIL src/app.test.ts' },
    review: { text: 'CHANGES requested', json: { approved: false, issues: ['naming'] } },
    lint: { output: '   ' },
  },
  inputs: { strict: 'true', retries: '3' },
};

const check = (cond: Condition) => evaluateCondition(cond, ctx);

describe('comparison operators', () => {
  it.each([
    [{ value: '${{ steps.tests.exitCode }}', op: 'eq', to: 1 }, true],
    [{ value: '${{ steps.tests.exitCode }}', op: 'eq', to: '1' }, true],
    [{ value: '${{ steps.tests.exitCode }}', op: 'neq', to: 0 }, true],
    [{ value: '${{ inputs.retries }}', op: 'gt', to: 2 }, true],
    [{ value: '${{ inputs.retries }}', op: 'gte', to: 3 }, true],
    [{ value: '${{ inputs.retries }}', op: 'lt', to: 10 }, true],
    [{ value: '${{ inputs.retries }}', op: 'lte', to: 2 }, false],
    [{ value: '${{ steps.tests.output }}', op: 'contains', to: 'FAIL' }, true],
    [{ value: '${{ steps.tests.output }}', op: 'notContains', to: 'PASS' }, true],
    [{ value: '${{ steps.review.json.issues }}', op: 'contains', to: 'naming' }, true],
    [{ value: '${{ steps.tests.output }}', op: 'matches', to: '\\d+ failed' }, true],
    [{ value: '${{ steps.tests.output }}', op: 'notMatches', to: '^PASS' }, true],
    [{ value: '${{ steps.review.text }}', op: 'startsWith', to: 'CHANGES' }, true],
    [{ value: '${{ steps.review.text }}', op: 'endsWith', to: 'requested' }, true],
    [{ value: '${{ steps.lint.output }}', op: 'isEmpty' }, true],
    [{ value: '${{ steps.missing.text }}', op: 'isEmpty' }, true],
    [{ value: '${{ steps.review.json.issues }}', op: 'isNotEmpty' }, true],
    [{ value: '${{ inputs.strict }}', op: 'isTrue' }, true],
    [{ value: '${{ steps.review.json.approved }}', op: 'isFalse' }, true],
  ] as const)('%j → %s', (cond, expected) => {
    expect(check(cond as Condition)).toBe(expected);
  });

  it('honours ignoreCase for string operators', () => {
    expect(check({ value: '${{ steps.review.text }}', op: 'contains', to: 'changes' })).toBe(false);
    expect(check({ value: '${{ steps.review.text }}', op: 'contains', to: 'changes', ignoreCase: true })).toBe(true);
    expect(check({ value: '${{ steps.review.text }}', op: 'eq', to: 'changes REQUESTED', ignoreCase: true })).toBe(true);
    expect(check({ value: '${{ steps.tests.output }}', op: 'matches', to: 'fail src', ignoreCase: true })).toBe(true);
  });

  it('renders templates inside the operand', () => {
    expect(check({ value: 'exit ${{ steps.tests.exitCode }}', op: 'eq', to: 'exit ${{ 0 + 1 }}' })).toBe(true);
  });
});

describe('groups', () => {
  it('combines with all, any and not', () => {
    const failing: Condition = { value: '${{ steps.tests.exitCode }}', op: 'neq', to: 0 };
    const approved: Condition = { value: '${{ steps.review.json.approved }}', op: 'isTrue' };
    expect(check({ all: [failing, approved] })).toBe(false);
    expect(check({ any: [failing, approved] })).toBe(true);
    expect(check({ not: approved })).toBe(true);
    expect(check({ all: [] })).toBe(true);
    expect(check({ any: [] })).toBe(false);
  });
});

describe('expression form', () => {
  it('accepts expressions with or without ${{ }}', () => {
    expect(check('${{ steps.tests.exitCode != 0 }}')).toBe(true);
    expect(check('steps.tests.exitCode == 0')).toBe(false);
    expect(check("${{ contains(steps.review.text, 'CHANGES') && !steps.review.json.approved }}")).toBe(true);
  });

  it('treats the text "false" and empty strings as false', () => {
    expect(check('${{ inputs.strict }}')).toBe(true);
    expect(check("${{ 'false' }}")).toBe(false);
    expect(check('${{ steps.lint.output }}')).toBe(false);
  });
});

describe('describeCondition', () => {
  it('summarizes structured conditions for block cards', () => {
    expect(describeCondition({ value: '${{ steps.tests.exitCode }}', op: 'neq', to: 0 })).toBe('tests.exitCode ≠ 0');
    expect(describeCondition({ value: '${{ steps.review.text }}', op: 'contains', to: 'LGTM' })).toBe(
      'review.text contains "LGTM"',
    );
    expect(describeCondition({ value: '${{ steps.lint.output }}', op: 'isEmpty' })).toBe('lint.output is empty');
    expect(
      describeCondition({
        all: [
          { value: '${{ steps.tests.exitCode }}', op: 'eq', to: 0 },
          { any: [{ value: '${{ steps.review.json.approved }}', op: 'isTrue' }, { not: '${{ inputs.strict }}' }] },
        ],
      }),
    ).toBe('tests.exitCode = 0 and (review.json.approved is true or not inputs.strict)');
  });

  it('summarizes expression conditions', () => {
    expect(describeCondition('${{ steps.tests.exitCode != 0 }}')).toBe('tests.exitCode != 0');
  });
});

describe('CONDITION_OPS', () => {
  it('lists operand-free operators', () => {
    const unary = CONDITION_OPS.filter((o) => !o.needsOperand).map((o) => o.op);
    expect(unary).toEqual(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);
  });
});
