/** Edit operations the canvas sends: inserting new blocks, moving, deleting and duplicating. Pure helpers. */
import {
  createDefaultStep,
  nextStepId,
  type InsertTarget,
  type Step,
  type StepType,
  type Workflow,
  type WorkflowOp,
} from '@isar-flow/core';
import { type BlockEntry, type CanvasModel, type ListInfo, ROOT_LIST, targetOf } from './model';

/** What is being dragged (or clicked in the palette / block picker). */
export type DragItem =
  | { kind: 'block'; stepType: StepType }
  | { kind: 'agent'; agentId: string; name: string }
  | { kind: 'move'; stepId: string; stepType: StepType | undefined; title: string };

export function itemStepType(item: DragItem): StepType | undefined {
  return item.kind === 'block' ? item.stepType : item.kind === 'agent' ? 'agent' : item.stepType;
}

/**
 * Whether `item` may be dropped into `list` before `index`. Containers cannot go into themselves, slots that
 * would not move the block are closed, Break needs a surrounding loop, and lists of containers without an id
 * cannot be addressed by edit operations.
 */
export function canDrop(item: DragItem, list: ListInfo, index: number, model: CanvasModel): boolean {
  if (!list.targetable) return false;
  if (itemStepType(item) === 'break' && !list.insideLoop) return false;
  if (item.kind !== 'move') return true;
  if (list.chain.includes(item.stepId)) return false;
  const entry = model.byId.get(item.stepId);
  if (entry && entry.list.key === list.key && (index === entry.index || index === entry.index + 1))
    return false;
  return true;
}

/** A new block for a palette item, with a fresh `<type>_<n>` id. */
export function newStep(
  item: Exclude<DragItem, { kind: 'move' }>,
  workflow: Workflow | null | undefined,
): Step {
  if (item.kind === 'agent') {
    return { id: nextStepId(workflow, 'agent'), type: 'agent', agent: item.agentId, prompt: '' };
  }
  return createDefaultStep(item.stepType, nextStepId(workflow, item.stepType));
}

export interface PlannedEdit {
  ops: WorkflowOp[];
  /** Block to select once the host applied the edit. */
  select?: string;
}

/** Ops for dropping (or click-inserting) `item` at `target`. */
export function dropEdit(
  item: DragItem,
  target: InsertTarget,
  workflow: Workflow | null | undefined,
): PlannedEdit {
  if (item.kind === 'move')
    return { ops: [{ op: 'moveStep', stepId: item.stepId, target }], select: item.stepId };
  const step = newStep(item, workflow);
  return { ops: [{ op: 'insertStep', target, step }], select: step.id };
}

/** Where a click in the palette inserts: after the selected block, else at the end of the workflow. */
export function insertionTarget(model: CanvasModel, selection: string | null): InsertTarget {
  const entry = selection ? model.byId.get(selection) : undefined;
  if (entry && entry.list.targetable) return targetOf(entry.list, entry.index + 1);
  return targetOf(ROOT_LIST, model.root.entries.length);
}

/** Alt+Up / Alt+Down: move a block one place within its list. Null at the ends. */
export function moveWithinList(entry: BlockEntry, delta: -1 | 1, siblings: number): WorkflowOp | null {
  if (!entry.id || !entry.list.targetable) return null;
  const next = entry.index + delta;
  if (next < 0 || next >= siblings) return null;
  // Target indexes refer to the list before the move, so moving down skips over the next block.
  return {
    op: 'moveStep',
    stepId: entry.id,
    target: targetOf(entry.list, delta < 0 ? next : entry.index + 2),
  };
}

/** Block to select after deleting `id`: the next one in document order outside it, else the previous one. */
export function selectionAfterDelete(model: CanvasModel, id: string): string | null {
  const entry = model.byId.get(id);
  if (!entry) return null;
  const inside = (candidate: string) => {
    for (let p = model.byId.get(candidate) ?? null; p; p = p.parent) if (p === entry) return true;
    return false;
  };
  const index = model.order.indexOf(id);
  for (let i = index + 1; i < model.order.length; i++) if (!inside(model.order[i])) return model.order[i];
  for (let i = index - 1; i >= 0; i--) if (!inside(model.order[i])) return model.order[i];
  return null;
}
