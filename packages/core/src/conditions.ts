import {
  compareValues,
  compileRegex,
  type ExpressionContext,
  evaluateExpression,
  findTemplateExpressions,
  looseEquals,
  renderTemplate,
  stringifyValue,
} from './expr';

export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'notMatches'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isTrue'
  | 'isFalse';

export interface ComparisonCondition {
  value: unknown;
  op: ConditionOp;
  to?: unknown;
  ignoreCase?: boolean;
}

export type Condition =
  | string
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | ComparisonCondition;

export interface ConditionOpInfo {
  op: ConditionOp;
  label: string;
  symbol: string;
  needsOperand: boolean;
}

export const CONDITION_OPS: readonly ConditionOpInfo[] = [
  { op: 'eq', label: 'equals', symbol: '=', needsOperand: true },
  { op: 'neq', label: 'does not equal', symbol: '≠', needsOperand: true },
  { op: 'gt', label: 'is greater than', symbol: '>', needsOperand: true },
  { op: 'gte', label: 'is at least', symbol: '≥', needsOperand: true },
  { op: 'lt', label: 'is less than', symbol: '<', needsOperand: true },
  { op: 'lte', label: 'is at most', symbol: '≤', needsOperand: true },
  { op: 'contains', label: 'contains', symbol: 'contains', needsOperand: true },
  { op: 'notContains', label: 'does not contain', symbol: 'does not contain', needsOperand: true },
  { op: 'matches', label: 'matches regex', symbol: 'matches', needsOperand: true },
  { op: 'notMatches', label: 'does not match regex', symbol: 'does not match', needsOperand: true },
  { op: 'startsWith', label: 'starts with', symbol: 'starts with', needsOperand: true },
  { op: 'endsWith', label: 'ends with', symbol: 'ends with', needsOperand: true },
  { op: 'isEmpty', label: 'is empty', symbol: 'is empty', needsOperand: false },
  { op: 'isNotEmpty', label: 'is not empty', symbol: 'is not empty', needsOperand: false },
  { op: 'isTrue', label: 'is true', symbol: 'is true', needsOperand: false },
  { op: 'isFalse', label: 'is false', symbol: 'is false', needsOperand: false },
];

const OP_INFO = new Map(CONDITION_OPS.map((o) => [o.op, o]));

export function isComparison(cond: Condition): cond is ComparisonCondition {
  return typeof cond === 'object' && cond !== null && 'op' in cond;
}

export function isGroup(cond: Condition): cond is { all: Condition[] } | { any: Condition[] } {
  return typeof cond === 'object' && cond !== null && ('all' in cond || 'any' in cond);
}

/** Converts a value to a boolean the way users expect from YAML/console text. */
export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return !(v === '' || v === 'false' || v === '0' || v === 'no' || v === 'off' || v === 'null');
  }
  return Boolean(value);
}

function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function resolve(value: unknown, ctx: ExpressionContext): unknown {
  return typeof value === 'string' ? renderTemplate(value, ctx) : value;
}

function fold(value: unknown, ignoreCase: boolean | undefined): unknown {
  return ignoreCase && typeof value === 'string' ? value.toLowerCase() : value;
}

function evaluateComparison(cond: ComparisonCondition, ctx: ExpressionContext): boolean {
  const ic = cond.ignoreCase;
  const left = resolve(cond.value, ctx);
  const right = resolve(cond.to, ctx);
  const ls = () => stringifyValue(fold(stringifyValue(left), ic));
  const rs = () => stringifyValue(fold(stringifyValue(right), ic));
  const contains = () =>
    Array.isArray(left) ? left.some((item) => looseEquals(fold(item, ic), fold(right, ic))) : ls().includes(rs());
  const matches = () => compileRegex(right, ic ? 'i' : '').test(stringifyValue(left));

  switch (cond.op) {
    case 'eq':
      return looseEquals(fold(left, ic), fold(right, ic));
    case 'neq':
      return !looseEquals(fold(left, ic), fold(right, ic));
    case 'gt':
      return compareValues(left, right) > 0;
    case 'gte':
      return compareValues(left, right) >= 0;
    case 'lt':
      return compareValues(left, right) < 0;
    case 'lte':
      return compareValues(left, right) <= 0;
    case 'contains':
      return contains();
    case 'notContains':
      return !contains();
    case 'matches':
      return matches();
    case 'notMatches':
      return !matches();
    case 'startsWith':
      return ls().startsWith(rs());
    case 'endsWith':
      return ls().endsWith(rs());
    case 'isEmpty':
      return isEmptyValue(left);
    case 'isNotEmpty':
      return !isEmptyValue(left);
    case 'isTrue':
      return toBoolean(left);
    case 'isFalse':
      return !toBoolean(left);
  }
}

export function evaluateCondition(cond: Condition, ctx: ExpressionContext): boolean {
  if (typeof cond === 'string') {
    const value = cond.includes('${{') ? renderTemplate(cond, ctx) : evaluateExpression(cond, ctx);
    return toBoolean(value);
  }
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, ctx));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, ctx));
  if ('not' in cond) return !evaluateCondition(cond.not, ctx);
  return evaluateComparison(cond, ctx);
}

/** Strips `${{ }}` and the `steps.` prefix so summaries read like `tests.exitCode ≠ 0`. */
function shortenExpression(expr: string): string {
  return expr.replace(/(^|[^A-Za-z0-9_.$-])steps\./g, '$1').trim();
}

function describeOperand(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const matches = findTemplateExpressions(value);
      if (matches.length === 1 && value.trim() === value.slice(matches[0].start, matches[0].end)) {
        return shortenExpression(matches[0].expr);
      }
    } catch {
      // Fall through to quoting the raw text.
    }
    return JSON.stringify(value);
  }
  return stringifyValue(value) || 'empty';
}

function describeExpression(text: string): string {
  try {
    const matches = findTemplateExpressions(text);
    if (matches.length === 1 && text.trim() === text.slice(matches[0].start, matches[0].end)) {
      return shortenExpression(matches[0].expr);
    }
  } catch {
    return text;
  }
  return shortenExpression(text);
}

export function describeCondition(cond: Condition, nested = false): string {
  if (typeof cond === 'string') return describeExpression(cond);
  if ('all' in cond || 'any' in cond) {
    const parts = 'all' in cond ? cond.all : cond.any;
    const joined = parts.map((c) => describeCondition(c, true)).join('all' in cond ? ' and ' : ' or ');
    return nested && parts.length > 1 ? `(${joined})` : joined;
  }
  if ('not' in cond) return `not ${describeCondition(cond.not, true)}`;
  const info = OP_INFO.get(cond.op);
  const left = describeOperand(cond.value);
  if (!info) return `${left} ${cond.op}`;
  return info.needsOperand ? `${left} ${info.symbol} ${describeOperand(cond.to)}` : `${left} ${info.symbol}`;
}
