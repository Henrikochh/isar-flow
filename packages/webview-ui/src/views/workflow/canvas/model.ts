/**
 * Canvas model: the workflow's block tree flattened into lists and entries with everything the river needs
 * (React keys by path, owning container, document order). Built defensively because the host sends a lenient
 * model when the YAML does not match the schema: blocks may lack ids, have unknown types or odd fields.
 */
import {
  STEP_TYPE_INFO,
  type InsertTarget,
  type Step,
  type StepSlot,
  type StepType,
  type Workflow,
} from '@isar-flow/core';

export interface ListInfo {
  /** Stable key of the list, also used in droppable ids. */
  key: string;
  /** Id of the owning container; null for the workflow root. */
  ownerId: string | null;
  slot: StepSlot;
  /** Ids of the containers from the root down to the owner ('' for containers without an id). */
  chain: string[];
  /** False when the owning container has no usable id, so edit operations cannot address the list. */
  targetable: boolean;
  /** True when the list is inside a loop (a Break block is allowed here). */
  insideLoop: boolean;
}

export interface ListModel {
  info: ListInfo;
  entries: BlockEntry[];
}

export interface BlockEntry {
  /** Path key, e.g. 'steps/1/then/0'. Used as React key. */
  key: string;
  step: Step;
  /** Usable id (non-empty string), if any. */
  id?: string;
  /** Known block type; undefined when the YAML names an unknown type. */
  type?: StepType;
  list: ListInfo;
  index: number;
  parent: BlockEntry | null;
  /** Nested lists of a loop (steps) or if (then, else). */
  children: ListModel[];
}

export interface CanvasModel {
  root: ListModel;
  /** All blocks in document order. */
  entries: BlockEntry[];
  /** First block for every id. */
  byId: Map<string, BlockEntry>;
  /** Ids of selectable blocks in document order. */
  order: string[];
}

export const ROOT_LIST: ListInfo = {
  key: 'root',
  ownerId: null,
  slot: 'steps',
  chain: [],
  targetable: true,
  insideLoop: false,
};

export function isStepType(value: unknown): value is StepType {
  return typeof value === 'string' && Object.hasOwn(STEP_TYPE_INFO, value);
}

export function isContainerType(type: StepType | undefined): boolean {
  return type === 'loop' || type === 'if';
}

function stepList(value: unknown): Step[] {
  return Array.isArray(value)
    ? (value.filter((s) => typeof s === 'object' && s !== null && !Array.isArray(s)) as Step[])
    : [];
}

function childSlots(type: StepType | undefined): StepSlot[] {
  if (type === 'loop') return ['steps'];
  if (type === 'if') return ['then', 'else'];
  return [];
}

export function buildCanvasModel(workflow: Workflow | null | undefined): CanvasModel {
  const entries: BlockEntry[] = [];
  const byId = new Map<string, BlockEntry>();

  const buildList = (steps: Step[], info: ListInfo, parent: BlockEntry | null, prefix: string): ListModel => {
    const list: ListModel = { info, entries: [] };
    steps.forEach((step, index) => {
      const rawId: unknown = (step as { id?: unknown }).id;
      const id = typeof rawId === 'string' && rawId.trim() !== '' ? rawId : undefined;
      const rawType: unknown = (step as { type?: unknown }).type;
      const type = isStepType(rawType) ? rawType : undefined;
      const key = `${prefix}/${index}`;
      const entry: BlockEntry = { key, step, id, type, list: info, index, parent, children: [] };
      entries.push(entry);
      if (id !== undefined && !byId.has(id)) byId.set(id, entry);
      for (const slot of childSlots(type)) {
        const childInfo: ListInfo = {
          key: `${key}/${slot}`,
          ownerId: id ?? null,
          slot,
          chain: [...info.chain, id ?? ''],
          targetable: id !== undefined,
          insideLoop: info.insideLoop || type === 'loop',
        };
        entry.children.push(
          buildList(
            stepList((step as unknown as Record<string, unknown>)[slot]),
            childInfo,
            entry,
            `${key}/${slot}`,
          ),
        );
      }
      list.entries.push(entry);
    });
    return list;
  };

  const root = buildList(stepList(workflow?.steps), ROOT_LIST, null, 'steps');
  const order = entries.filter((e) => e.id !== undefined && byId.get(e.id) === e).map((e) => e.id as string);
  return { root, entries, byId, order };
}

export function targetOf(info: ListInfo, index: number): InsertTarget {
  return { parentId: info.ownerId, slot: info.slot, index };
}

/** Text value of a lenient field: strings as-is, numbers and booleans stringified, anything else empty. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Display title of a block: its name, else its id. */
export function blockTitle(entry: BlockEntry): string {
  const name = textOf((entry.step as { name?: unknown }).name).trim();
  return name || entry.id || 'Unnamed block';
}

/** Nearest ancestor of the given type. */
export function nearestAncestor(entry: BlockEntry, type: StepType, stopAt?: BlockEntry): BlockEntry | null {
  for (let p = entry.parent; p && p !== stopAt; p = p.parent) if (p.type === type) return p;
  return null;
}

/** True when `entry` is `ancestor` or nested inside it. */
export function isWithin(entry: BlockEntry, ancestor: BlockEntry): boolean {
  for (let p: BlockEntry | null = entry; p; p = p.parent) if (p === ancestor) return true;
  return false;
}
