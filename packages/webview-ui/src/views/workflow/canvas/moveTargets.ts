/** Lists a block can be moved to with "Move to…", the keyboard-friendly alternative to dragging. Pure helpers. */
import type { InsertTarget } from '@isar-flow/core';
import { type BlockEntry, blockTitle, type CanvasModel, type ListModel, targetOf } from './model';
import { canDrop, type DragItem } from './ops';

export interface MoveTarget {
  /** Key of the list, unique in the model. */
  key: string;
  /** Container that owns the list; null for the top level. */
  owner: BlockEntry | null;
  list: ListModel;
  /** The end of the list. */
  target: InsertTarget;
  /** False when the block is already the last one in this list, so moving would change nothing. */
  changes: boolean;
}

/** All lists in document order: the top level, then each container's lists as they appear. */
function allLists(model: CanvasModel): { list: ListModel; owner: BlockEntry | null }[] {
  const lists: { list: ListModel; owner: BlockEntry | null }[] = [{ list: model.root, owner: null }];
  for (const entry of model.entries) for (const list of entry.children) lists.push({ list, owner: entry });
  return lists;
}

/**
 * Where block `stepId` can go: the end of the top level, of every loop body and of every Then and Else lane,
 * except lists inside the block itself, lists of containers without an id, and (for Break) lists outside loops.
 */
export function moveTargets(model: CanvasModel, stepId: string): MoveTarget[] {
  const entry = model.byId.get(stepId);
  if (!entry) return [];
  const item: DragItem = { kind: 'move', stepId, stepType: entry.type, title: blockTitle(entry) };
  const targets: MoveTarget[] = [];
  for (const { list, owner } of allLists(model)) {
    if (!list.info.targetable) continue;
    const index = list.entries.length;
    const alreadyLast = list.info.key === entry.list.key && entry.index === index - 1;
    if (!alreadyLast && !canDrop(item, list.info, index, model)) continue;
    targets.push({
      key: list.info.key,
      owner,
      list,
      target: targetOf(list.info, index),
      changes: !alreadyLast,
    });
  }
  return targets;
}
