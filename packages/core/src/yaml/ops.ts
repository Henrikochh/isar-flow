import {
  type Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  Pair,
  visit,
  type YAMLMap,
  YAMLSeq,
} from 'yaml';
import { STEP_ID_PATTERN } from '../schema';
import type { StepSlot } from '../schema/types';
import { assignMissingIds } from './assignIds';
import { EditError, loadForEdit, stringifyDocument } from './document';
import {
  type BlockNode,
  blockIdOf,
  collectBlockIds,
  collectBlockIdsIn,
  findBlockNode,
  forEachBlockList,
  STEP_SLOTS,
  walkBlockNodes,
} from './locate';
import { findPair } from './nodePath';
import {
  createValueNode,
  deleteMapKey,
  insertPair,
  isPlainObject,
  setMapValue,
  STEP_KEY_ORDER,
  WORKFLOW_KEY_ORDER,
} from './nodes';
import { rewriteReferencesIn } from './references';
import type { ApplyOpsResult, InsertTarget, WorkflowOp } from './types';

const ID_RULE = 'Block ids start with a letter or _ and contain only letters, digits, _ and -.';

function requireBlock(root: YAMLMap, id: string): BlockNode {
  const block = findBlockNode(root, id);
  if (!block) throw new EditError(`Block '${id}' not found`);
  return block;
}

function assertValidId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') throw new EditError(`Every block needs an id. ${ID_RULE}`);
  if (!STEP_ID_PATTERN.test(id)) throw new EditError(`Invalid block id '${id}'. ${ID_RULE}`);
}

/** Validates the ids of blocks about to be added (nested ones too) and reserves them in `used`. */
function reserveIds(steps: readonly unknown[], used: Set<string>): void {
  for (const step of steps) {
    if (!isPlainObject(step)) throw new EditError('Each block must be a mapping with at least id and type');
    assertValidId(step.id);
    if (used.has(step.id)) throw new EditError(`A block with id '${step.id}' already exists`);
    used.add(step.id);
    for (const slot of STEP_SLOTS) {
      const children = step[slot];
      if (Array.isArray(children)) reserveIds(children, used);
    }
  }
}

/** Blocks are only ever found through a scalar string id, so the id node always exists. */
function setId(block: YAMLMap, id: string): void {
  const node = block.get('id', true);
  if (isScalar(node)) node.value = id;
}

/** `review_loop` → `review_loop_2`; `agent_1` → `agent_2` (numeric suffixes count up instead of stacking). */
function freshId(id: string, used: ReadonlySet<string>): string {
  const base = id.replace(/_\d+$/, '') || id;
  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function clampIndex(index: unknown, length: number): number {
  return typeof index === 'number' && Number.isInteger(index) ? Math.min(Math.max(index, 0), length) : length;
}

/* ---------- blank lines and comments in block lists ---------- */

const usesBlankLines = (list: YAMLSeq) =>
  list.items.some((item, i) => i > 0 && isNode(item) && item.spaceBefore === true);

/** The first item never starts with a blank line; `touched` items follow the list's blank-line convention. */
function fixSpacing(list: YAMLSeq, blankLines: boolean, touched: readonly unknown[]): void {
  list.items.forEach((item, i) => {
    if (!isNode(item)) return;
    if (i === 0) {
      if (item.spaceBefore) item.spaceBefore = false;
    } else if (touched.includes(item)) {
      item.spaceBefore = blankLines;
    }
  });
}

/**
 * An emptied block list is written as `[]` either way; marking it as flow keeps a trailing comment on the key
 * line (`steps: [] # later`) instead of producing `steps:\n  []\n  # later`.
 */
function removeFromList(list: YAMLSeq, node: Node, blankLines: boolean): void {
  list.items.splice(list.items.indexOf(node), 1);
  if (list.items.length === 0) list.flow = true;
  fixSpacing(list, blankLines, []);
}

function insertIntoList(list: YAMLSeq, node: Node, index: number, blankLines = usesBlankLines(list)): void {
  const previousFirst = list.items[0];
  if (list.flow && list.items.length === 0) list.flow = false;
  list.items.splice(clampIndex(index, list.items.length), 0, node);
  fixSpacing(list, blankLines, [node, previousFirst]);
}

/**
 * The parser attaches a comment above the first item of a list to the list itself. It describes that item,
 * so it should move, be copied or be deleted together with it. Comment lines followed by a blank line describe
 * the list and stay; the parser marks that blank line with a trailing "\n" in the comment text.
 */
function attachLeadingComment(list: YAMLSeq): void {
  const first = list.items[0];
  const comment = list.commentBefore;
  if (!comment || list.flow || !isNode(first) || first.spaceBefore) return;
  const split = comment.lastIndexOf('\n\n');
  const own = comment.endsWith('\n') ? '' : split === -1 ? comment : comment.slice(split + 2);
  if (own === '') return;
  first.commentBefore = first.commentBefore ? `${own}\n${first.commentBefore}` : own;
  list.commentBefore = own === comment ? undefined : comment.slice(0, split + 1);
}

function dropEmptyElse(block: BlockNode): void {
  if (block.parent && block.slot === 'else' && block.list.items.length === 0) {
    deleteMapKey(block.parent, 'else');
  }
}

/* ---------- targets ---------- */

function ensureList(doc: Document, map: YAMLMap, key: StepSlot, order: readonly string[]): YAMLSeq {
  const pair = findPair(map, key);
  if (pair && isSeq(pair.value)) return pair.value;
  const empty = !pair || pair.value === null || (isScalar(pair.value) && pair.value.value === null);
  if (!empty) throw new EditError(`'${key}' must be a list of blocks. Fix it in the YAML first.`);
  const list = new YAMLSeq(doc.schema);
  if (pair) {
    if (isScalar(pair.value) && pair.value.comment) list.commentBefore = pair.value.comment;
    pair.value = list;
  } else {
    insertPair(map, new Pair(doc.createNode(key), list), order);
  }
  return list;
}

function resolveTarget(doc: Document, root: YAMLMap, target: InsertTarget): YAMLSeq {
  if (!isPlainObject(target)) throw new EditError('The operation needs a target (parentId, slot and index)');
  if (target.parentId === null || target.parentId === undefined) {
    if (target.slot !== 'steps') {
      throw new EditError(
        `The workflow has no '${String(target.slot)}' list. Use slot 'steps' for top-level blocks.`,
      );
    }
    return ensureList(doc, root, 'steps', WORKFLOW_KEY_ORDER);
  }
  const parent = findBlockNode(root, target.parentId);
  if (!parent) throw new EditError(`Parent block '${target.parentId}' not found`);
  const type: unknown = parent.node.get('type');
  const slots: StepSlot[] = type === 'loop' ? ['steps'] : type === 'if' ? ['then', 'else'] : [];
  if (slots.length === 0) throw new EditError(`Block '${target.parentId}' cannot contain blocks`);
  if (!slots.includes(target.slot)) {
    const options = slots.map((s) => `'${s}'`).join(' or ');
    throw new EditError(
      `Block '${target.parentId}' cannot contain blocks in '${String(target.slot)}'. Use ${options}.`,
    );
  }
  return ensureList(doc, parent.node, target.slot, STEP_KEY_ORDER);
}

/* ---------- operations ---------- */

function insertStep(doc: Document, root: YAMLMap, target: InsertTarget, step: unknown): void {
  if (!isPlainObject(step)) {
    throw new EditError('The block to insert must be a mapping with at least id and type');
  }
  reserveIds([step], collectBlockIds(root));
  const list = resolveTarget(doc, root, target);
  insertIntoList(list, createValueNode(doc, step, 'step'), target.index);
}

function moveStep(doc: Document, root: YAMLMap, stepId: string, target: InsertTarget): void {
  const block = requireBlock(root, stepId);
  if (isPlainObject(target) && typeof target.parentId === 'string') {
    const parent = findBlockNode(root, target.parentId);
    if (parent && (parent.node === block.node || parent.ancestors.includes(block.node))) {
      throw new EditError('Cannot move a block into itself or one of its children');
    }
  }
  const sourceBlankLines = usesBlankLines(block.list);
  const list = resolveTarget(doc, root, target);
  const targetBlankLines = list === block.list ? sourceBlankLines : usesBlankLines(list);
  const from = block.list.items.indexOf(block.node);
  let index = clampIndex(target.index, list.items.length);
  if (list === block.list && from < index) index--;
  removeFromList(block.list, block.node, sourceBlankLines);
  insertIntoList(list, block.node, index, targetBlankLines);
  dropEmptyElse(block);
}

function deleteStep(root: YAMLMap, stepId: string): void {
  const block = requireBlock(root, stepId);
  removeFromList(block.list, block.node, false);
  dropEmptyElse(block);
}

function duplicateStep(root: YAMLMap, stepId: string): void {
  const block = requireBlock(root, stepId);
  const copy = block.node.clone() as YAMLMap;
  copy.commentBefore = undefined;
  // A repeated anchor would silently redirect later aliases to the copy.
  visit(copy, (_, node) => {
    if (isNode(node) && node.anchor) node.anchor = undefined;
  });
  const used = collectBlockIds(root);
  const renames = new Map<string, string>();
  const copiedBlocks: YAMLMap[] = [];
  const renameAll = (map: YAMLMap) => {
    copiedBlocks.push(map);
    const id = blockIdOf(map);
    if (id !== undefined) {
      const next = freshId(id, used);
      used.add(next);
      if (!renames.has(id)) renames.set(id, next);
      setId(map, next);
    }
    for (const slot of STEP_SLOTS) {
      const list = map.get(slot, true);
      if (isSeq(list)) for (const item of list.items) if (isMap(item)) renameAll(item);
    }
  };
  renameAll(copy);
  rewriteReferencesIn(copy, copiedBlocks, renames);
  insertIntoList(block.list, copy, block.list.items.indexOf(block.node) + 1);
}

function updateStep(
  doc: Document,
  root: YAMLMap,
  stepId: string,
  set: Record<string, unknown>,
  unset: readonly string[] = [],
): void {
  const values = isPlainObject(set) ? set : {};
  if (Object.hasOwn(values, 'id') || unset.includes('id')) {
    throw new EditError(`Block ids cannot be changed with updateStep. Use renameStep to rename '${stepId}'.`);
  }
  const block = requireBlock(root, stepId);
  const replacedSlots = STEP_SLOTS.filter((slot) => Array.isArray(values[slot]));
  if (replacedSlots.length > 0) {
    const used = collectBlockIds(root);
    for (const slot of replacedSlots) {
      const list = block.node.get(slot, true);
      if (isSeq(list)) for (const id of collectBlockIdsIn(list)) used.delete(id);
    }
    for (const slot of replacedSlots) reserveIds(values[slot] as unknown[], used);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) deleteMapKey(block.node, key);
    else setMapValue(doc, block.node, key, value, 'step', STEP_KEY_ORDER);
  }
  for (const key of unset) deleteMapKey(block.node, key);
}

function renameStep(root: YAMLMap, stepId: string, newId: string): void {
  const block = requireBlock(root, stepId);
  if (newId === stepId) return;
  assertValidId(newId);
  if (collectBlockIds(root).has(newId)) throw new EditError(`A block with id '${newId}' already exists`);
  setId(block.node, newId);
  const blocks: YAMLMap[] = [];
  walkBlockNodes(root, ({ node }) => {
    blocks.push(node);
  });
  rewriteReferencesIn(root, blocks, new Map([[stepId, newId]]));
}

function updateWorkflow(
  doc: Document,
  root: YAMLMap,
  set: Record<string, unknown>,
  unset: readonly string[] = [],
): void {
  const values = isPlainObject(set) ? set : {};
  if (Object.hasOwn(values, 'steps') || unset.includes('steps')) {
    throw new EditError("Use insertStep, moveStep and deleteStep to change the blocks in 'steps'");
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) deleteMapKey(root, key);
    else setMapValue(doc, root, key, value, 'workflow', WORKFLOW_KEY_ORDER);
  }
  for (const key of unset) deleteMapKey(root, key);
}

function applyOp(doc: Document, root: YAMLMap, op: WorkflowOp): void {
  switch (op.op) {
    case 'insertStep':
      return insertStep(doc, root, op.target, op.step);
    case 'moveStep':
      return moveStep(doc, root, op.stepId, op.target);
    case 'deleteStep':
      return deleteStep(root, op.stepId);
    case 'duplicateStep':
      return duplicateStep(root, op.stepId);
    case 'updateStep':
      return updateStep(doc, root, op.stepId, op.set, op.unset);
    case 'renameStep':
      return renameStep(root, op.stepId, op.newId);
    case 'updateWorkflow':
      return updateWorkflow(doc, root, op.set, op.unset);
    case 'assignMissingIds':
      return assignMissingIds(doc, root);
    default:
      throw new EditError(`Unknown operation '${String((op as { op?: unknown }).op)}'`);
  }
}

/**
 * Applies canvas edits to the YAML text, preserving comments, blank lines, quoting and key order of
 * everything that is not edited. Atomic: on any error the original text is returned with the error.
 */
export function applyWorkflowOps(text: string, ops: readonly WorkflowOp[]): ApplyOpsResult {
  try {
    const edit = loadForEdit(text, 'workflow');
    forEachBlockList(edit.root, attachLeadingComment);
    for (const op of ops) applyOp(edit.doc, edit.root, op);
    return { text: stringifyDocument(edit, text) };
  } catch (err) {
    if (err instanceof EditError) return { text, error: err.message };
    return { text, error: `Could not apply the edit: ${err instanceof Error ? err.message : String(err)}` };
  }
}
