import {
  type Document,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  type YAMLMap,
} from 'yaml';
import type { Range } from '../diagnostics';
import { offsetsToRange, type PositionMapper } from './position';

/** String form of a mapping key, or undefined for complex keys. */
export function keyString(key: unknown): string | undefined {
  if (typeof key === 'string') return key;
  if (
    isScalar(key) &&
    (typeof key.value === 'string' || typeof key.value === 'number' || typeof key.value === 'boolean')
  ) {
    return String(key.value);
  }
  return undefined;
}

export function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => keyString(pair.key) === key);
}

export interface PathLookup {
  /** The node at the path when `exact`, otherwise the nearest existing ancestor. */
  node: Node | null;
  /** Key node of the last path segment, when that entry exists in a mapping. */
  key?: Node;
  exact: boolean;
}

/** Finds the YAML node at a data path, or the nearest existing ancestor. */
export function lookupPath(doc: Document, path: readonly PropertyKey[]): PathLookup {
  let node: Node | null = isNode(doc.contents) ? doc.contents : null;
  let key: Node | undefined;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    const current: unknown = isAlias(node) ? node.resolve(doc) : node;
    let next: unknown;
    if (isMap(current)) {
      const pair = findPair(current, String(segment));
      if (!pair) return { node, exact: false };
      if (i === path.length - 1 && isNode(pair.key)) key = pair.key;
      next = pair.value;
    } else if (isSeq(current) && typeof segment === 'number') {
      next = current.items[segment];
    }
    if (!isNode(next)) return { node, key, exact: false };
    node = next;
  }
  return { node, key, exact: true };
}

function trimEnd(text: string, start: number, end: number): number {
  let e = end;
  while (e > start && /\s/.test(text[e - 1])) e--;
  return e;
}

/** Full range of a node, without trailing whitespace. */
export function fullRange(node: Node, text: string, map: PositionMapper): Range | undefined {
  if (!node.range) return undefined;
  const [start, end] = node.range;
  return offsetsToRange(map, start, trimEnd(text, start, end));
}

/** Range for squiggles: block collections are reduced to their first line so whole blocks are not underlined. */
export function focusRange(node: Node, text: string, map: PositionMapper): Range | undefined {
  if (!node.range) return undefined;
  if (!isCollection(node) || node.flow) return fullRange(node, text, map);
  const [start, end] = node.range;
  const lineEnd = text.slice(start, end).search(/[\r\n]/);
  return offsetsToRange(map, start, trimEnd(text, start, lineEnd === -1 ? end : start + lineEnd));
}
