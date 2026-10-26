import { isMap, isSeq, type YAMLMap, type YAMLSeq } from 'yaml';
import type { StepSlot } from '../schema/types';

export const STEP_SLOTS: readonly StepSlot[] = ['steps', 'then', 'else'];

export interface BlockNode {
  node: YAMLMap;
  id: string | undefined;
  list: YAMLSeq;
  index: number;
  /** Containing block; null for top-level blocks. */
  parent: YAMLMap | null;
  slot: StepSlot;
  /** Containing blocks from the top level down to the parent. */
  ancestors: YAMLMap[];
}

export function blockIdOf(node: YAMLMap): string | undefined {
  const id: unknown = node.get('id');
  return typeof id === 'string' ? id : undefined;
}

/**
 * Visits every block mapping in document order. Nested lists are followed for any block (not only for
 * loop/if), so id uniqueness also covers blocks hidden in mistyped containers. Return false to skip children.
 */
export function walkBlockNodes(root: YAMLMap, visit: (block: BlockNode) => void | false): void {
  const recurse = (container: YAMLMap, parent: YAMLMap | null, ancestors: YAMLMap[]) => {
    for (const slot of parent ? STEP_SLOTS : (['steps'] as const)) {
      const list = container.get(slot, true);
      if (!isSeq(list)) continue;
      list.items.forEach((item, index) => {
        if (!isMap(item)) return;
        const descend =
          visit({ node: item, id: blockIdOf(item), list, index, parent, slot, ancestors }) !== false;
        if (descend) recurse(item, item, [...ancestors, item]);
      });
    }
  };
  recurse(root, null, []);
}

export function findBlockNode(root: YAMLMap, id: string): BlockNode | undefined {
  let found: BlockNode | undefined;
  walkBlockNodes(root, (block) => {
    if (found) return false;
    if (block.id === id) found = block;
  });
  return found;
}

export function collectBlockIds(root: YAMLMap): Set<string> {
  const ids = new Set<string>();
  walkBlockNodes(root, (block) => {
    if (block.id !== undefined) ids.add(block.id);
  });
  return ids;
}

/** Ids of all blocks inside a block list, including nested ones. */
export function collectBlockIdsIn(list: YAMLSeq): string[] {
  const ids: string[] = [];
  const visitList = (seq: YAMLSeq) => {
    for (const item of seq.items) {
      if (!isMap(item)) continue;
      const id = blockIdOf(item);
      if (id !== undefined) ids.push(id);
      for (const slot of STEP_SLOTS) {
        const child = item.get(slot, true);
        if (isSeq(child)) visitList(child);
      }
    }
  };
  visitList(list);
  return ids;
}

/** Calls `fn` for every block list (top-level `steps` and nested `steps`/`then`/`else`). */
export function forEachBlockList(root: YAMLMap, fn: (list: YAMLSeq) => void): void {
  const top = root.get('steps', true);
  if (isSeq(top)) fn(top);
  walkBlockNodes(root, ({ node }) => {
    for (const slot of STEP_SLOTS) {
      const list = node.get(slot, true);
      if (isSeq(list)) fn(list);
    }
  });
}
