/**
 * Conversions behind the condition builder: structured conditions ⇄ one level of rules, and simple
 * expressions ⇄ rules, so users can switch between the Rules and Expression modes without losing work.
 */
import {
  analyzeExpression,
  type ComparisonCondition,
  CONDITION_OPS,
  type Condition,
  type ConditionOp,
  type Expr,
  findTemplateExpressions,
  FUNCTION_NAMES,
  parseExpression,
} from '@isar-flow/core';
import { isRecord } from './model';

export type Combinator = 'all' | 'any';

export interface Rule {
  value: unknown;
  op: ConditionOp;
  to?: unknown;
  ignoreCase?: boolean;
}

export interface RuleSet {
  combinator: Combinator;
  rules: Rule[];
}

const OP_INFO = new Map(CONDITION_OPS.map((info) => [info.op, info]));

export function needsOperand(op: ConditionOp): boolean {
  return OP_INFO.get(op)?.needsOperand ?? true;
}

/** Operators where "ignore case" changes the result. */
export const TEXT_OPS: ReadonlySet<ConditionOp> = new Set<ConditionOp>([
  'eq',
  'neq',
  'contains',
  'notContains',
  'matches',
  'notMatches',
  'startsWith',
  'endsWith',
]);

export function isRule(value: unknown): value is ComparisonCondition {
  return isRecord(value) && typeof value.op === 'string' && OP_INFO.has(value.op as ConditionOp);
}

/* ---------- templates ---------- */

/** `${{ expr }}` */
export function toTemplate(expr: string): string {
  return `\${{ ${expr.trim()} }}`;
}

/** Inner expression of a string that is exactly one `${{ … }}` template (surrounding spaces allowed); else null. */
export function singleTemplate(text: string): string | null {
  try {
    const matches = findTemplateExpressions(text);
    if (matches.length !== 1) return null;
    const lead = text.length - text.trimStart().length;
    return matches[0].start === lead && matches[0].end === text.trimEnd().length ? matches[0].expr : null;
  } catch {
    return null;
  }
}

/** Text for the expression editor: the inner expression of a single template, otherwise the raw string. */
export function expressionText(condition: string): string {
  return singleTemplate(condition) ?? condition;
}

/** Stored form of what the user typed in the expression editor. */
export function expressionCondition(text: string): string {
  const trimmed = text.trim();
  return trimmed.includes('${{') ? trimmed : toTemplate(trimmed);
}

/** Readable problem with an expression (syntax or unknown function), or null when it parses. */
export function expressionProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'Enter an expression, for example steps.tests.exitCode == 0.';
  let sources: string[];
  try {
    sources = trimmed.includes('${{') ? findTemplateExpressions(trimmed).map((m) => m.expr) : [trimmed];
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  for (const source of sources) {
    try {
      parseExpression(source);
      const unknown = analyzeExpression(source).functions.find((name) => !FUNCTION_NAMES.includes(name));
      if (unknown) return `Unknown function '${unknown}'. Available: ${FUNCTION_NAMES.join(', ')}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const offset = (error as { offset?: number }).offset;
      return sources.length === 1 && typeof offset === 'number' ? `${message} (column ${offset + 1})` : message;
    }
  }
  return null;
}

/* ---------- operands ---------- */

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** Operand typed by the user: numbers and booleans become typed values, everything else stays text. */
export function parseOperand(text: string): unknown {
  const trimmed = text.trim();
  if (NUMBER.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return text;
}

export function formatOperand(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Canonical key of a rule value, so `${{steps.a.b}}` and `${{ steps.a.b }}` match the same picker option. */
export function valueKey(value: unknown): string {
  if (typeof value !== 'string') return formatOperand(value);
  const inner = singleTemplate(value);
  return inner === null ? value : toTemplate(inner);
}

/**
 * Stored rule value for text chosen in the value picker: templates stay as typed, things that read like a
 * reference (`steps.tests.stdout`, `inputs.mode`) are wrapped in `${{ }}`, anything else is literal text.
 */
export function valueFromText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes('${{')) return trimmed;
  try {
    const expr = parseExpression(trimmed);
    if (expr.kind !== 'literal') return toTemplate(trimmed);
  } catch {
    // Not an expression: keep it as text.
  }
  return text;
}

/* ---------- structured conditions ---------- */

function cleanRule(rule: Rule): ComparisonCondition {
  const out: ComparisonCondition = { value: rule.value, op: rule.op };
  if (needsOperand(rule.op)) out.to = rule.to ?? '';
  if (rule.ignoreCase && TEXT_OPS.has(rule.op)) out.ignoreCase = true;
  return out;
}

/** Condition written for a rule set; a single rule is written without a group, like hand-written YAML. */
export function writeRules(set: RuleSet): Condition {
  if (set.rules.length === 1) return cleanRule(set.rules[0]);
  const rules = set.rules.map(cleanRule);
  return set.combinator === 'any' ? { any: rules } : { all: rules };
}

/**
 * Rules for a condition, or null when it cannot be shown as one level of rules (nested groups, `not`, or an
 * expression that is not a simple chain of comparisons). A missing condition is an empty rule set.
 */
export function readRules(condition: unknown): RuleSet | null {
  if (condition === undefined || condition === null) return { combinator: 'all', rules: [] };
  if (typeof condition === 'string') return expressionToRules(condition);
  if (!isRecord(condition)) return null;
  if (isRule(condition)) return { combinator: 'all', rules: [condition as Rule] };
  const combinator: Combinator | null = Array.isArray(condition.all) ? 'all' : Array.isArray(condition.any) ? 'any' : null;
  if (!combinator) return null;
  const items = condition[combinator] as unknown[];
  if (!items.every(isRule)) return null;
  return { combinator, rules: items as Rule[] };
}

/** True for structured conditions deeper than one group (or using `not`): only YAML can edit those. */
export function isNestedCondition(condition: unknown): boolean {
  return isRecord(condition) && readRules(condition) === null;
}

/* ---------- expressions ⇄ rules ---------- */

const COMPARISON: Partial<Record<string, ConditionOp>> = {
  '==': 'eq',
  '!=': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};
const MIRRORED: Partial<Record<ConditionOp, ConditionOp>> = { gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte' };
const FUNCTION_OPS: Partial<Record<string, ConditionOp>> = {
  contains: 'contains',
  matches: 'matches',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
};
const NEGATED: Partial<Record<ConditionOp, ConditionOp>> = { contains: 'notContains', matches: 'notMatches' };

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Prints an expression tree back to source, adding parentheses only where precedence needs them. */
export function printExpression(expr: Expr, parent = 0): string {
  switch (expr.kind) {
    case 'literal':
      return typeof expr.value === 'string' ? quote(expr.value) : String(expr.value);
    case 'ident':
      return expr.name;
    case 'member': {
      const object = printExpression(expr.object, 9);
      if (!expr.computed && expr.property.kind === 'literal') {
        const name = String(expr.property.value);
        return IDENTIFIER.test(name) || /^\d+$/.test(name) ? `${object}.${name}` : `${object}[${quote(name)}]`;
      }
      return `${object}[${printExpression(expr.property)}]`;
    }
    case 'call':
      return `${expr.callee}(${expr.args.map((a) => printExpression(a)).join(', ')})`;
    case 'array':
      return `[${expr.elements.map((e) => printExpression(e)).join(', ')}]`;
    case 'unary': {
      const text = `${expr.op}${printExpression(expr.arg, 8)}`;
      return parent > 8 ? `(${text})` : text;
    }
    case 'binary':
    case 'logical': {
      const own = PRECEDENCE[expr.op];
      const text = `${printExpression(expr.left, own)} ${expr.op} ${printExpression(expr.right, own + 1)}`;
      return own < parent ? `(${text})` : text;
    }
    case 'conditional': {
      const text = `${printExpression(expr.test, 1)} ? ${printExpression(expr.consequent)} : ${printExpression(expr.alternate)}`;
      return parent > 0 ? `(${text})` : text;
    }
  }
}

function operandOf(expr: Expr): { value: unknown } | null {
  if (expr.kind === 'literal') return expr.value === null ? null : { value: expr.value };
  return { value: toTemplate(printExpression(expr)) };
}

function leafToRule(expr: Expr): Rule | null {
  if (expr.kind === 'binary') {
    let op = COMPARISON[expr.op];
    if (!op) return null;
    let { left, right } = expr;
    if (left.kind === 'literal' && right.kind !== 'literal') {
      [left, right] = [right, left];
      op = MIRRORED[op] ?? op;
    }
    if (left.kind === 'literal') return null;
    const to = operandOf(right);
    return to ? { value: toTemplate(printExpression(left)), op, to: to.value } : null;
  }
  if (expr.kind === 'call') {
    const op = FUNCTION_OPS[expr.callee];
    if (!op || expr.args.length < 2 || expr.args.length > 3) return null;
    const [subject, operand, extra] = expr.args;
    if (subject.kind === 'literal') return null;
    const to = operandOf(operand);
    if (!to) return null;
    const rule: Rule = { value: toTemplate(printExpression(subject)), op, to: to.value };
    if (extra) {
      const ignoreCase =
        (op === 'contains' && extra.kind === 'literal' && extra.value === true) ||
        (op === 'matches' && extra.kind === 'literal' && extra.value === 'i');
      if (!ignoreCase) return null;
      rule.ignoreCase = true;
    }
    return rule;
  }
  if (expr.kind === 'unary' && expr.op === '!') {
    const inner = leafToRule(expr.arg);
    const negated = inner && NEGATED[inner.op];
    if (inner && negated && expr.arg.kind === 'call') return { ...inner, op: negated };
    if (expr.arg.kind === 'ident' || expr.arg.kind === 'member') {
      return { value: toTemplate(printExpression(expr.arg)), op: 'isFalse' };
    }
    return null;
  }
  if (expr.kind === 'ident' || expr.kind === 'member') return { value: toTemplate(printExpression(expr)), op: 'isTrue' };
  return null;
}

/** Rules equivalent to a simple expression (`a == 1 && contains(b, 'x')`); null for anything more complex. */
export function expressionToRules(text: string): RuleSet | null {
  const trimmed = text.trim();
  const source = trimmed.includes('${{') ? singleTemplate(trimmed) : trimmed;
  if (source === null || source === '') return null;
  let expr: Expr;
  try {
    expr = parseExpression(source);
  } catch {
    return null;
  }
  if (expr.kind === 'literal' && expr.value === true) return { combinator: 'all', rules: [] };
  let combinator: Combinator | null = null;
  const leaves: Expr[] = [];
  const flatten = (node: Expr): boolean => {
    if (node.kind !== 'logical') {
      leaves.push(node);
      return true;
    }
    const own: Combinator = node.op === '&&' ? 'all' : 'any';
    if (combinator && combinator !== own) return false;
    combinator = own;
    return flatten(node.left) && flatten(node.right);
  };
  if (!flatten(expr)) return null;
  const rules: Rule[] = [];
  for (const leaf of leaves) {
    const rule = leafToRule(leaf);
    if (!rule) return null;
    rules.push(rule);
  }
  return { combinator: combinator ?? 'all', rules };
}

/** Source of a rule value or operand inside an expression; null when it cannot be expressed. */
function operandSource(value: unknown): string | null {
  if (value === undefined) return "''";
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  const inner = singleTemplate(value);
  if (inner === null) return value.includes('${{') ? null : quote(value);
  try {
    return printExpression(parseExpression(inner), 8);
  } catch {
    return null;
  }
}

function ruleToExpression(rule: Rule): string | null {
  const left = operandSource(rule.value);
  const right = operandSource(rule.to);
  if (left === null || (needsOperand(rule.op) && right === null)) return null;
  const ic = Boolean(rule.ignoreCase) && TEXT_OPS.has(rule.op);
  const l = ic ? `lower(${left})` : left;
  const r = ic ? `lower(${right})` : right;
  switch (rule.op) {
    case 'eq':
      return `${l} == ${r}`;
    case 'neq':
      return `${l} != ${r}`;
    case 'gt':
      return `${left} > ${right}`;
    case 'gte':
      return `${left} >= ${right}`;
    case 'lt':
      return `${left} < ${right}`;
    case 'lte':
      return `${left} <= ${right}`;
    case 'contains':
      return `contains(${left}, ${right}${ic ? ', true' : ''})`;
    case 'notContains':
      return `!contains(${left}, ${right}${ic ? ', true' : ''})`;
    case 'matches':
      return `matches(${left}, ${right}${ic ? ", 'i'" : ''})`;
    case 'notMatches':
      return `!matches(${left}, ${right}${ic ? ", 'i'" : ''})`;
    case 'startsWith':
      return `startsWith(${l}, ${r})`;
    case 'endsWith':
      return `endsWith(${l}, ${r})`;
    case 'isEmpty':
      return `length(${left}) == 0`;
    case 'isNotEmpty':
      return `length(${left}) > 0`;
    case 'isTrue':
      return left;
    case 'isFalse':
      return `!${left}`;
  }
}

/** A close expression equivalent of a rule set, used to prefill the expression editor; null when impossible. */
export function rulesToExpression(set: RuleSet): string | null {
  if (set.rules.length === 0) return 'true';
  const parts: string[] = [];
  for (const rule of set.rules) {
    const part = ruleToExpression(rule);
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join(set.combinator === 'any' ? ' || ' : ' && ');
}
