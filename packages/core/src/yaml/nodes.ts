import {
  type Document,
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  Pair,
  Scalar,
  type YAMLMap,
} from 'yaml';
import { setFlowPadding } from './document';
import { findPair, keyString } from './nodePath';

/** What a mapping represents; decides key order and compact styling of new nodes. */
export type NodeKind = 'workflow' | 'step' | 'agent' | 'condition' | 'other';

export const WORKFLOW_KEY_ORDER = [
  'version',
  'name',
  'description',
  'inputs',
  'env',
  'isolation',
  'setup',
  'steps',
];

export const STEP_KEY_ORDER = [
  'id',
  'name',
  'type',
  'agent',
  'model',
  'prompt',
  'run',
  'shell',
  'cwd',
  'env',
  'message',
  'outcome',
  'condition',
  'until',
  'while',
  'maxIterations',
  'onMaxIterations',
  'output',
  'session',
  'context',
  'timeout',
  'retry',
  'continueOnError',
  'onReject',
  'steps',
  'then',
  'else',
];

export const AGENT_KEY_ORDER = [
  'name',
  'description',
  'model',
  'fallbackModels',
  'systemPrompt',
  'temperature',
  'maxTokens',
  'maxTurns',
  'tools',
  'toolMode',
  'permissions',
];

const COMPARISON_KEY_ORDER = ['value', 'op', 'to', 'ignoreCase'];
const CONDITION_KEYS = new Set(['condition', 'until', 'while']);
const BLOCK_LIST_KEYS = new Set(['steps', 'then', 'else']);
/** Short scalar-only collections that read best on one line, as in `tools: [readFile, gitDiff]`. */
const COMPACT_KEYS = new Set(['tools', 'fallbackModels', 'permissions', 'retry', 'files']);

type Primitive = string | number | boolean | null;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPrimitive = (value: unknown): value is Primitive =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** Block scalars cannot hold `\r`, so a CRLF in a value would force an escaped double-quoted string. */
const normalizeLineBreaks = <T>(value: T): T =>
  (typeof value === 'string' && value.includes('\r\n') ? value.replace(/\r\n/g, '\n') : value) as T;

export function childKind(kind: NodeKind, key: string): NodeKind {
  switch (kind) {
    case 'workflow':
      return key === 'steps' ? 'step' : 'other';
    case 'step':
      if (BLOCK_LIST_KEYS.has(key)) return 'step';
      if (CONDITION_KEYS.has(key)) return 'condition';
      return key === 'agent' ? 'agent' : 'other';
    case 'condition':
      return key === 'all' || key === 'any' || key === 'not' ? 'condition' : 'other';
    default:
      return 'other';
  }
}

export function keyOrder(kind: NodeKind, value: Record<string, unknown>): readonly string[] {
  switch (kind) {
    case 'workflow':
      return WORKFLOW_KEY_ORDER;
    case 'step':
      return STEP_KEY_ORDER;
    case 'agent':
      return AGENT_KEY_ORDER;
    case 'condition':
      return 'op' in value ? COMPARISON_KEY_ORDER : Object.keys(value);
    default:
      return Object.keys(value);
  }
}

/** Deep copy with keys in canonical order (unknown keys keep their order, after the known ones). */
function ordered(value: unknown, kind: NodeKind): unknown {
  if (Array.isArray(value)) return value.map((item) => ordered(item, kind));
  if (!isPlainObject(value)) return normalizeLineBreaks(value);
  const order = keyOrder(kind, value);
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort((a, b) => rank(a) - rank(b));
  return Object.fromEntries(keys.map((key) => [key, ordered(value[key], childKind(kind, key))]));
}

const isSingleLineScalar = (node: unknown) => isScalar(node) && !String(node.value).includes('\n');

function onlyShortScalars(node: Node): boolean {
  if (isMap(node)) return node.items.every((pair) => isSingleLineScalar(pair.value));
  if (isSeq(node)) return node.items.every(isSingleLineScalar);
  return false;
}

function style(node: unknown, kind: NodeKind, key: string | undefined): void {
  if (isScalar(node)) {
    if (typeof node.value !== 'string') return;
    if (node.value.includes('\n')) node.type = Scalar.BLOCK_LITERAL;
    // Plain `${{ … }}` is valid YAML but easy to misread; the docs and templates always quote it.
    else if (node.value.includes('${{')) node.type = Scalar.QUOTE_DOUBLE;
    return;
  }
  const compact = key !== undefined && COMPACT_KEYS.has(key);
  if (isMap(node)) {
    if ((kind === 'condition' && node.has('op')) || (compact && onlyShortScalars(node))) node.flow = true;
    for (const pair of node.items) {
      const childKey = keyString(pair.key) ?? '';
      style(pair.value, childKind(kind, childKey), childKey);
    }
  } else if (isSeq(node)) {
    if (compact && onlyShortScalars(node)) {
      node.flow = true;
      setFlowPadding(node, false);
    }
    for (const item of node.items) style(item, kind, undefined);
  }
}

/** Creates a node for a JSON-like value with canonical key order and Isar Flow's preferred styles. */
export function createValueNode(doc: Document, value: unknown, kind: NodeKind, key?: string): Node {
  const created: unknown = doc.createNode(ordered(value, kind), { aliasDuplicateObjects: false });
  if (!isNode(created)) throw new Error('Could not create a YAML node for the value');
  style(created, kind, key);
  return created;
}

/** Keeps comments and blank lines of a node that is replaced by a new one. */
function transferComments(from: Node, to: Node): void {
  if (from.spaceBefore) to.spaceBefore = true;
  const blockCollection = isCollection(to) && !to.flow;
  const before = [from.commentBefore, blockCollection ? from.comment : undefined].filter(Boolean).join('\n');
  if (before) to.commentBefore = before;
  if (!blockCollection && from.comment) to.comment = from.comment;
}

function updateScalar(node: Scalar, value: Primitive): void {
  if (node.value === value) return;
  node.value = value;
  const block = node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;
  if (typeof value === 'string' && value.includes('\n') && !block) node.type = Scalar.BLOCK_LITERAL;
}

/**
 * Makes `node` represent `value`, changing existing nodes in place where the shapes match so comments,
 * quoting and block styles inside them survive. Returns the node to store (new when shapes differ).
 */
export function reconcileNode(
  doc: Document,
  node: unknown,
  value: unknown,
  kind: NodeKind,
  key?: string,
): Node {
  if (isScalar(node) && isPrimitive(value)) {
    updateScalar(node, normalizeLineBreaks(value));
    return node;
  }
  // An empty flow collection (`[]`, `{}`) that gains content is rebuilt so it gets the regular styles.
  const fillsEmptyFlow = (size: number) =>
    isCollection(node) && node.flow && node.items.length === 0 && size > 0;
  if (isMap(node) && isPlainObject(value) && !fillsEmptyFlow(Object.keys(value).length)) {
    updateMap(doc, node, value, kind);
    return node;
  }
  if (isSeq(node) && Array.isArray(value) && !fillsEmptyFlow(value.length)) {
    value.forEach((item, index) => {
      if (index < node.items.length) node.items[index] = reconcileNode(doc, node.items[index], item, kind);
      else node.items.push(createValueNode(doc, item, kind));
    });
    node.items.splice(value.length);
    return node;
  }
  const created = createValueNode(doc, value, kind, key);
  if (isNode(node)) transferComments(node, created);
  return created;
}

/** Inserts a pair after the last key that comes before it in `order` (unknown keys go last). */
export function insertPair(map: YAMLMap, pair: Pair, order: readonly string[]): void {
  const rank = (key: unknown) => {
    const name = keyString(key);
    const index = name === undefined ? -1 : order.indexOf(name);
    return index === -1 ? Infinity : index;
  };
  const own = rank(pair.key);
  let index = map.items.length;
  if (own !== Infinity) {
    let after = -1;
    let firstKnown = -1;
    map.items.forEach((p, i) => {
      const r = rank(p.key);
      if (r < own) after = i;
      if (r !== Infinity && firstKnown === -1) firstKnown = i;
    });
    if (after !== -1) index = after + 1;
    else if (firstKnown !== -1) index = firstKnown;
  }
  map.items.splice(index, 0, pair);
}

/** Sets one entry of a mapping, updating an existing value in place or inserting at the canonical position. */
export function setMapValue(
  doc: Document,
  map: YAMLMap,
  key: string,
  value: unknown,
  kind: NodeKind,
  order: readonly string[] = keyOrder(kind, { [key]: value }),
): void {
  const pair = findPair(map, key);
  const valueKind = childKind(kind, key);
  if (pair) pair.value = reconcileNode(doc, pair.value, value, valueKind, key);
  else insertPair(map, new Pair(doc.createNode(key), createValueNode(doc, value, valueKind, key)), order);
}

export function deleteMapKey(map: YAMLMap, key: string): void {
  map.items = map.items.filter((pair) => keyString(pair.key) !== key);
}

/** Replaces the entries of a mapping with those of `value` (missing keys are removed). */
export function updateMap(doc: Document, map: YAMLMap, value: Record<string, unknown>, kind: NodeKind): void {
  map.items = map.items.filter((pair) => {
    const name = keyString(pair.key);
    return name !== undefined && Object.hasOwn(value, name) && value[name] !== undefined;
  });
  const order = keyOrder(kind, value);
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) setMapValue(doc, map, key, item, kind, order);
  }
}
