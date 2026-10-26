import type { Document, Node } from 'yaml';
import type { z } from 'zod';
import type { Diagnostic, Range } from '../diagnostics';
import { focusRange, lookupPath } from './nodePath';
import type { PositionMapper } from './position';

type Issue = z.core.$ZodIssue;
type Path = readonly PropertyKey[];

export interface IssueContext {
  doc: Document;
  data: unknown;
  text: string;
  map: PositionMapper;
  /** Attribute diagnostics to blocks (workflows only). */
  blocks: boolean;
}

/** Where the squiggle goes: the key of an entry, its value, or the nearest existing parent. */
type Target = 'key' | 'value' | 'parent';

const BLOCK_SLOTS = new Set(['steps', 'then', 'else']);
const CONDITION_KEYS = new Set(['condition', 'until', 'while', 'not']);

const EXPECTED: Record<string, string> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  array: 'a list',
  object: 'a mapping',
  record: 'a mapping',
  null: 'empty',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function valueAt(data: unknown, path: Path): unknown {
  let current = data;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') current = current[segment];
    else if (isRecord(current) && typeof segment === 'string' && Object.hasOwn(current, segment))
      current = current[segment];
    else return undefined;
  }
  return current;
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}

function found(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'an empty value';
  if (typeof value === 'string') return `'${truncate(value)}'`;
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return String(value);
}

function quoted(value: unknown): string {
  return typeof value === 'string' ? `'${truncate(value)}'` : found(value);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function joinOr(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function subject(path: Path): string {
  const last = path[path.length - 1];
  if (last === undefined) return 'The file';
  if (typeof last === 'number') return `Item ${last + 1} of '${String(path[path.length - 2])}'`;
  return `'${String(last)}'`;
}

/** "for 'shell'" for mapping entries, "in 'tools'" for list items. */
function location(path: Path): string {
  const last = path[path.length - 1];
  return typeof last === 'number' ? `in '${String(path[path.length - 2])}'` : `for '${String(last)}'`;
}

function isConditionPath(path: Path): boolean {
  const last = path[path.length - 1];
  const parent = path[path.length - 2];
  if (typeof last === 'string') return CONDITION_KEYS.has(last);
  return typeof last === 'number' && (parent === 'all' || parent === 'any');
}

/** Id of the innermost block that contains the path, when that block has a string id. */
function innermostStepId(data: unknown, path: Path): string | undefined {
  let node = data;
  let id: string | undefined;
  let container: 'root' | 'block' | null = 'root';
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const index = path[i + 1];
    const isSlot =
      container === 'block' ? BLOCK_SLOTS.has(String(key)) : container === 'root' && key === 'steps';
    if (isSlot && typeof index === 'number') {
      const block = valueAt(node, [key, index]);
      if (!isRecord(block)) return id;
      id = typeof block.id === 'string' ? block.id : undefined;
      node = block;
      container = 'block';
      i++;
      continue;
    }
    node = valueAt(node, [key]);
    container = null;
  }
  return id;
}

/** An empty value (`prompt:` with nothing after it) has a zero-width node that an editor can hardly show. */
const isZeroWidth = (node: Node) =>
  node.range !== undefined && node.range !== null && node.range[0] === node.range[1];

function rangeFor(ctx: IssueContext, path: Path, target: Target): Range | undefined {
  const lookup = lookupPath(ctx.doc, path);
  if (target === 'key' && lookup.key) return focusRange(lookup.key, ctx.text, ctx.map);
  if (target === 'value' && lookup.exact && lookup.node && !(lookup.key && isZeroWidth(lookup.node))) {
    return focusRange(lookup.node, ctx.text, ctx.map);
  }
  if (target === 'value' && lookup.key) return focusRange(lookup.key, ctx.text, ctx.map);
  return lookup.node ? focusRange(lookup.node, ctx.text, ctx.map) : undefined;
}

function push(
  out: Diagnostic[],
  ctx: IssueContext,
  code: string,
  message: string,
  path: Path,
  target: Target,
): void {
  const diagnostic: Diagnostic = {
    severity: 'error',
    code,
    message,
    path: path.map((segment) => (typeof segment === 'number' ? segment : String(segment))),
  };
  const range = rangeFor(ctx, path, target);
  if (range) diagnostic.range = range;
  const stepId = ctx.blocks ? innermostStepId(ctx.data, path) : undefined;
  if (stepId !== undefined) diagnostic.stepId = stepId;
  out.push(diagnostic);
}

function missing(out: Diagnostic[], ctx: IssueContext, path: Path, hint = ''): void {
  push(
    out,
    ctx,
    'missing-property',
    `Missing required property '${String(path[path.length - 1])}'${hint}`,
    path,
    'parent',
  );
}

function rangeMessage(
  issue: Extract<Issue, { code: 'too_small' | 'too_big' }>,
  path: Path,
  value: unknown,
): string {
  const small = issue.code === 'too_small';
  const limit = Number(small ? issue.minimum : issue.maximum);
  const who = subject(path);
  if (issue.origin === 'string') {
    if (small && limit === 1) return `${who} must not be empty`;
    return `${who} must have ${small ? 'at least' : 'at most'} ${limit} characters`;
  }
  if (issue.origin === 'array' || issue.origin === 'set') {
    return `${who} must have ${small ? 'at least' : 'at most'} ${limit} item${limit === 1 ? '' : 's'}`;
  }
  const bound =
    issue.inclusive === false ? (small ? 'greater than' : 'less than') : small ? 'at least' : 'at most';
  return `${who} must be ${bound} ${limit} (found ${found(value)})`;
}

function valueMessage(issue: Issue, path: Path, value: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      return `${subject(path)} must be ${EXPECTED[issue.expected] ?? issue.expected} (found ${found(value)})`;
    case 'too_small':
    case 'too_big':
      return rangeMessage(issue, path, value);
    case 'invalid_value': {
      if (issue.values.length === 1) {
        return `${subject(path)} must be ${String(issue.values[0])} (found ${found(value)})`;
      }
      const options = issue.values.map(String).join(', ');
      return `Invalid value ${quoted(value)} ${location(path)}. Use one of: ${options}.`;
    }
    case 'invalid_format':
      return `Invalid value ${quoted(value)} ${location(path)}. ${sentence(issue.message)}`;
    case 'not_multiple_of':
      return `${subject(path)} must be a multiple of ${issue.divisor} (found ${found(value)})`;
    default:
      return issue.message;
  }
}

/** A union branch that rejected the value's basic type (e.g. expected text, got a mapping). */
const isRootTypeIssue = (issue: Issue): issue is Extract<Issue, { code: 'invalid_type' }> =>
  issue.path.length === 0 && issue.code === 'invalid_type';

/**
 * Zod reports every failed branch of a union. Branches that rejected the value's basic type are irrelevant;
 * of the rest, the one with the fewest problems is what the user most likely meant.
 */
function describeUnion(
  issue: Extract<Issue, { code: 'invalid_union' }>,
  path: Path,
  value: unknown,
  ctx: IssueContext,
  out: Diagnostic[],
): void {
  if (issue.discriminator) {
    const options = (('options' in issue && issue.options) || []).map(String).join(', ');
    if (value === undefined) return missing(out, ctx, path, `. Use one of: ${options}.`);
    const isType = issue.discriminator === 'type';
    const message =
      value === null || value === ''
        ? `${subject(path)} must not be empty. Use one of: ${options}.`
        : isType
          ? `Unknown block type ${quoted(value)}. Use one of: ${options}.`
          : `Invalid value ${quoted(value)} ${location(path)}. Use one of: ${options}.`;
    return push(out, ctx, isType ? 'unknown-block-type' : 'invalid-value', message, path, 'value');
  }
  if (value === undefined) return missing(out, ctx, path);
  const candidates = issue.errors.filter((errors) => errors.length > 0 && !errors.some(isRootTypeIssue));
  const emptyCondition = isConditionPath(path) && isRecord(value) && Object.keys(value).length === 0;
  if (candidates.length === 0 || emptyCondition) {
    const expected = issue.errors.flatMap((errors) =>
      errors.filter(isRootTypeIssue).map((e) => EXPECTED[e.expected] ?? e.expected),
    );
    const message = isConditionPath(path)
      ? `${subject(path)} must be a condition (found ${found(value)}). Use an expression such as ` +
        '"${{ steps.tests.exitCode == 0 }}" or a mapping with all, any, not or value and op.'
      : `${subject(path)} must be ${joinOr([...new Set(expected)])} (found ${found(value)})`;
    return push(out, ctx, 'invalid-value', message, path, 'value');
  }
  const best = candidates.reduce((a, b) => (b.length < a.length ? b : a));
  for (const sub of best) describeIssue(sub, [...path, ...sub.path], ctx, out);
}

function describeIssue(issue: Issue, path: Path, ctx: IssueContext, out: Diagnostic[]): void {
  const value = valueAt(ctx.data, path);
  switch (issue.code) {
    case 'unrecognized_keys':
      for (const key of issue.keys)
        push(out, ctx, 'unknown-property', `Unknown property '${key}'`, [...path, key], 'key');
      return;
    case 'invalid_union':
      return describeUnion(issue, path, value, ctx, out);
    case 'invalid_key': {
      const reason = issue.issues[0]?.message;
      const message = `Invalid name ${quoted(path[path.length - 1])} in '${String(path[path.length - 2])}'.${
        reason ? ` ${sentence(reason)}` : ''
      }`;
      return push(out, ctx, 'invalid-value', message, path, 'key');
    }
    case 'invalid_type':
    case 'invalid_value':
      if (value === undefined) return missing(out, ctx, path);
      break;
    case 'custom':
      return push(out, ctx, 'invalid-value', issue.message, path, 'value');
  }
  push(out, ctx, 'invalid-value', valueMessage(issue, path, value), path, 'value');
}

function compareRanges(a: Diagnostic, b: Diagnostic): number {
  if (!a.range || !b.range) return a.range ? -1 : b.range ? 1 : 0;
  return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
}

/** Converts schema issues into readable diagnostics, one per problem, ordered by position. */
export function schemaDiagnostics(issues: readonly Issue[], ctx: IssueContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const issue of issues) describeIssue(issue, issue.path, ctx, out);
  const seen = new Set<string>();
  return out
    .filter((d) => {
      const key = `${d.code}\u0000${d.message}\u0000${JSON.stringify(d.path)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareRanges);
}
