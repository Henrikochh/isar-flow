/**
 * Run overlay logic: which blocks and river segments a run has reached. Loops re-run their blocks, so a block
 * whose latest execution belongs to an earlier iteration of a still-running loop counts as not reached yet.
 */
import type { RunView, StepRunView, StepSlot, StepStatus } from '@isar-flow/core';
import { type BlockEntry, type ListModel, nearestAncestor } from './model';

/** idle = no run shown; passed = the current flowed here; pending = not reached; current = flowing right now. */
export type FlowState = 'idle' | 'passed' | 'pending' | 'current';
export type LaneState = 'idle' | 'passed' | 'pending' | 'untaken';

function viewOf(run: RunView, entry: BlockEntry | null): StepRunView | undefined {
  return entry?.id ? run.steps[entry.id] : undefined;
}

/** True when the block's recorded state is from an earlier iteration of its (still running) loop. */
export function isStale(run: RunView, entry: BlockEntry): boolean {
  const view = viewOf(run, entry);
  const loop = nearestAncestor(entry, 'loop');
  const loopView = viewOf(run, loop);
  if (!view || !loop || !loopView) return false;
  if (isStale(run, loop)) return true;
  if (loopView.status !== 'running') return false;
  if (view.status === 'skipped') {
    // Skipped blocks never start; they belong to the round in which their If decided.
    const decider = nearestAncestor(entry, 'if', loop);
    return decider ? isStale(run, decider) || viewOf(run, decider) === undefined : false;
  }
  return (view.iteration ?? 0) < (loopView.loop?.iteration ?? 0);
}

/** Status of a block in the shown run, or undefined without a run. */
export function effectiveStatus(run: RunView | null, entry: BlockEntry): StepStatus | undefined {
  if (!run) return undefined;
  const view = viewOf(run, entry);
  if (!view || isStale(run, entry)) return 'pending';
  return view.status;
}

const FLOWED_THROUGH: ReadonlySet<StepStatus | undefined> = new Set(['success']);

function flowedPast(run: RunView, entry: BlockEntry): boolean {
  const status = effectiveStatus(run, entry);
  if (FLOWED_THROUGH.has(status)) return true;
  // A failed block with continueOnError lets the run go on.
  return status === 'failure' && (entry.step as { continueOnError?: unknown }).continueOnError === true;
}

/** State of the If's lane `slot` in the shown run. */
export function laneState(run: RunView | null, ifEntry: BlockEntry, slot: StepSlot): LaneState {
  if (!run) return 'idle';
  const status = effectiveStatus(run, ifEntry);
  if (status === undefined || status === 'pending' || status === 'skipped') return 'pending';
  const branch = viewOf(run, ifEntry)?.output?.branch;
  if (branch === 'then' || branch === 'else') return branch === slot ? 'passed' : 'untaken';
  const lanes = ifEntry.children;
  const started = (list: ListModel | undefined) =>
    list?.entries.some((e) => {
      const s = effectiveStatus(run, e);
      return s !== 'pending' && s !== 'skipped';
    }) ?? false;
  const own = lanes.find((l) => l.info.slot === slot);
  const other = lanes.find((l) => l.info.slot !== slot);
  if (started(own)) return 'passed';
  if (started(other)) return 'untaken';
  return 'pending';
}

/** Whether the owner of `list` let the current into this list at all. */
function listReachable(run: RunView, list: ListModel, owner: BlockEntry | null): boolean {
  if (!owner) return true;
  if (owner.type === 'if') return laneState(run, owner, list.info.slot) === 'passed';
  const status = effectiveStatus(run, owner);
  return status !== 'pending' && status !== 'skipped';
}

/**
 * State of river segment `k` of `list` (segment k sits above block k; segment n is the trailing one).
 * `owner` is the container the list belongs to, null for the root.
 */
export function segmentState(
  run: RunView | null,
  list: ListModel,
  k: number,
  owner: BlockEntry | null,
): FlowState {
  if (!run) return 'idle';
  if (!listReachable(run, list, owner)) return 'pending';
  const items = list.entries;
  if (k < items.length) {
    const entry = items[k];
    if (run.status === 'running' && entry.id && entry.id === run.activeStepId) return 'current';
    const status = effectiveStatus(run, entry);
    return status === 'pending' || status === 'skipped' ? 'pending' : 'passed';
  }
  if (items.length === 0) {
    if (!owner) return run.status === 'success' ? 'passed' : 'pending';
    return effectiveStatus(run, owner) === 'pending' ? 'pending' : 'passed';
  }
  return flowedPast(run, items[items.length - 1]) ? 'passed' : 'pending';
}

/** Loop shown in a run: current iteration (while running) or number of iterations that ran. */
export function loopProgress(
  run: RunView | null,
  loop: BlockEntry,
): { running: boolean; iteration: number; maxIterations: number } | null {
  if (!run || !loop.id) return null;
  const view = run.steps[loop.id];
  if (!view?.loop || isStale(run, loop)) return null;
  return {
    running: view.status === 'running',
    iteration: view.loop.iteration,
    maxIterations: view.loop.maxIterations,
  };
}
