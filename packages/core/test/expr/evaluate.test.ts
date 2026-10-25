import { describe, expect, it } from 'vitest';
import { analyzeExpression, evaluateExpression, ExpressionError, parseExpression } from '../../src/expr';

const ctx = {
  inputs: { task: 'Add login', count: 3, flag: true },
  steps: {
    tests: { exitCode: 1, output: 'line1\r\nline2\r\nFAIL src/a.test.ts\r\nline4\r\n', status: 'failure' },
    review: { text: 'Looks good. LGTM', json: { approved: true, issues: ['a', 'b'] } },
    'my-step': { text: 'dash' },
  },
  loop: { iteration: 2 },
  empty: '',
  nothing: null,
  numStr: '0',
};

const ev = (src: string) => evaluateExpression(src, ctx);

describe('literals and arithmetic', () => {
  it('evaluates literals', () => {
    expect(ev('42')).toBe(42);
    expect(ev('3.5')).toBe(3.5);
    expect(ev("'single'")).toBe('single');
    expect(ev('"double"')).toBe('double');
    expect(ev("'it\\'s'")).toBe("it's");
    expect(ev('true')).toBe(true);
    expect(ev('false')).toBe(false);
    expect(ev('null')).toBe(null);
  });

  it('respects operator precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('1 + 2 * 3 == 7')).toBe(true);
    expect(ev('10 % 4 - 1')).toBe(1);
    expect(ev('-2 * 3')).toBe(-6);
  });

  it('concatenates when either side of + is a string', () => {
    expect(ev("'a' + 1")).toBe('a1');
    expect(ev("inputs.task + '!'")).toBe('Add login!');
  });

  it('supports array literals', () => {
    expect(ev("['a', 'b']")).toEqual(['a', 'b']);
    expect(ev("contains(['x', 'y'], 'y')")).toBe(true);
  });
});

describe('member access', () => {
  it('reads nested properties', () => {
    expect(ev('steps.tests.exitCode')).toBe(1);
    expect(ev("steps['review'].json.approved")).toBe(true);
    expect(ev('steps.review.json.issues[1]')).toBe('b');
    expect(ev('steps.review.json.issues.length')).toBe(2);
  });

  it('allows dashes inside identifiers like GitHub Actions', () => {
    expect(ev('steps.my-step.text')).toBe('dash');
  });

  it('returns undefined for missing paths instead of throwing', () => {
    expect(ev('steps.missing.text')).toBeUndefined();
    expect(ev('nothing.deep.path')).toBeUndefined();
    expect(ev('unknownRoot')).toBeUndefined();
  });

  it('blocks prototype access', () => {
    expect(ev('steps.constructor')).toBeUndefined();
    expect(ev("steps['__proto__']")).toBeUndefined();
    expect(ev('inputs.task.constructor')).toBeUndefined();
  });
});

describe('comparison and logic', () => {
  it('compares number-like strings numerically', () => {
    expect(ev('numStr == 0')).toBe(true);
    expect(ev("'10' > 9")).toBe(true);
    expect(ev("'abc' == 'ABC'")).toBe(false);
    expect(ev('steps.tests.exitCode != 0')).toBe(true);
  });

  it('treats null and undefined as equal to each other only', () => {
    expect(ev('nothing == null')).toBe(true);
    expect(ev('steps.missing == null')).toBe(true);
    expect(ev("empty == null")).toBe(false);
  });

  it('compares booleans with their string form', () => {
    expect(ev("inputs.flag == 'true'")).toBe(true);
  });

  it('accepts === and !== as aliases', () => {
    expect(ev('1 === 1')).toBe(true);
    expect(ev('1 !== 2')).toBe(true);
  });

  it('short-circuits && and ||', () => {
    expect(ev('false && json(empty)')).toBe(false);
    expect(ev('true || json(empty)')).toBe(true);
    expect(ev("empty || 'fallback'")).toBe('fallback');
  });

  it('supports the ternary operator', () => {
    expect(ev("loop.iteration > 1 ? 'again' : 'first'")).toBe('again');
  });

  it('negates with !', () => {
    expect(ev('!steps.review.json.approved')).toBe(false);
    expect(ev('!empty')).toBe(true);
  });
});

describe('functions', () => {
  it('contains on strings and arrays, optionally ignoring case', () => {
    expect(ev("contains(steps.tests.output, 'FAIL')")).toBe(true);
    expect(ev("contains(steps.review.text, 'lgtm')")).toBe(false);
    expect(ev("contains(steps.review.text, 'lgtm', true)")).toBe(true);
    expect(ev("contains(steps.review.json.issues, 'b')")).toBe(true);
    expect(ev("contains(nothing, 'x')")).toBe(false);
  });

  it('startsWith and endsWith', () => {
    expect(ev("startsWith(inputs.task, 'Add')")).toBe(true);
    expect(ev("endsWith(inputs.task, 'login')")).toBe(true);
  });

  it('matches with flags', () => {
    expect(ev("matches(steps.tests.output, 'fail\\\\s+src', 'i')")).toBe(true);
    expect(ev("matches(steps.review.text, '^nope')")).toBe(false);
  });

  it('throws a readable error for invalid regex', () => {
    expect(() => ev("matches('x', '(')")).toThrow(ExpressionError);
  });

  it('head, tail and lines handle CRLF and trailing newlines', () => {
    expect(ev('tail(steps.tests.output, 2)')).toBe('FAIL src/a.test.ts\nline4');
    expect(ev('head(steps.tests.output, 1)')).toBe('line1');
    expect(ev('length(lines(steps.tests.output))')).toBe(4);
  });

  it('length, lower, upper, trim', () => {
    expect(ev('length(inputs.task)')).toBe(9);
    expect(ev('length(nothing)')).toBe(0);
    expect(ev("lower('ABC')")).toBe('abc');
    expect(ev("upper('abc')")).toBe('ABC');
    expect(ev("trim('  x ')")).toBe('x');
  });

  it('json and toJSON', () => {
    expect(ev(`json('{"a": [1, 2]}').a[1]`)).toBe(2);
    expect(() => ev("json('not json')")).toThrow(/json\(\)/);
    expect(ev('toJSON(steps.review.json.issues)')).toBe('[\n  "a",\n  "b"\n]');
  });

  it('join, default, number and string', () => {
    expect(ev("join(steps.review.json.issues, '; ')")).toBe('a; b');
    expect(ev('join(steps.review.json.issues)')).toBe('a, b');
    expect(ev("default(steps.missing.text, 'none')")).toBe('none');
    expect(ev("default(empty, 'none')")).toBe('none');
    expect(ev("number('12') + 1")).toBe(13);
    expect(ev('string(12) + 1')).toBe('121');
  });

  it('coerces non-string inputs for string functions', () => {
    expect(ev("contains(123, '2')")).toBe(true);
    expect(ev("startsWith(nothing, '')")).toBe(true);
  });

  it('rejects unknown functions', () => {
    expect(() => ev('explode()')).toThrow(/Unknown function 'explode'/);
  });
});

describe('parse errors', () => {
  it('reports the offset of unexpected tokens', () => {
    try {
      parseExpression('1 + * 2');
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionError);
      expect((e as ExpressionError).offset).toBe(4);
    }
  });

  it('rejects unterminated strings and trailing input', () => {
    expect(() => parseExpression("'abc")).toThrow(/Unterminated string/);
    expect(() => parseExpression('a b')).toThrow(/Unexpected/);
    expect(() => parseExpression('')).toThrow(/Empty expression/);
  });
});

describe('analyzeExpression', () => {
  it('collects member paths and function names', () => {
    const result = analyzeExpression("contains(steps.tests.output, 'x') && steps['review'].json.approved");
    expect(result.references).toEqual([
      ['steps', 'tests', 'output'],
      ['steps', 'review', 'json', 'approved'],
    ]);
    expect(result.functions).toEqual(['contains']);
  });

  it('stops paths at dynamic computed members', () => {
    const result = analyzeExpression('steps[inputs.name].text');
    expect(result.references).toContainEqual(['steps']);
    expect(result.references).toContainEqual(['inputs', 'name']);
  });
});
