import { iterationLimit } from '../engine/limits';
import { SECRET_MASK } from '../engine/mask';
import { blockId, type ResumePath, resumePath, splitAtTarget } from '../engine/resume';
import type { ResumeOptions, StepOutput } from '../engine/types';
import type { Step, Workflow } from '../schema/types';
import { blockHash } from './blockHash';
import type { ResumeLoopPoint, ResumePreview, RunView } from './types';

const BLOCKERS = {
  missing: "This block isn't in the workflow anymore.",
  running: 'Wait until the run has finished.',
  simulated: "Simulated runs can't be continued. Run the workflow, then run from a block.",
} as const;

function blocked(runId: string, stepId: string, blocker: string): ResumePreview {
  return {
    runId,
    stepId,
    blocker,
    reused: [],
    changed: [],
    missing: [],
    trimmed: [],
    masked: [],
    changesUnknown: false,
    loops: [],
    forcedBranches: [],
    freshSessions: [],
  };
}

function containsMask(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return value.includes(SECRET_MASK);
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => key.includes(SECRET_MASK) || containsMask(item, seen));
}

function storedOf(run: RunView, id: string) {
  return Object.hasOwn(run.steps, id) ? run.steps[id] : undefined;
}

function loopPoints(run: RunView, path: ResumePath): ResumeLoopPoint[] {
  return path.ancestors.flatMap((step) => {
    const id = blockId(step);
    if (step.type !== 'loop' || id === undefined) return [];
    const iteration = storedOf(run, id)?.loop?.iteration ?? 1;
    return [{ stepId: id, iteration, maxIterations: iterationLimit(step.maxIterations) }];
  });
}

function forcedBranches(run: RunView, path: ResumePath): ResumePreview['forcedBranches'] {
  return [...path.branches].flatMap(([step, branch]) => {
    const id = blockId(step);
    const stored = id === undefined ? undefined : storedOf(run, id)?.output?.branch;
    return id !== undefined && (stored === 'then' || stored === 'else') && stored !== branch
      ? [{ stepId: id, branch }]
      : [];
  });
}

function freshSessions(run: RunView, fromTarget: Step[]): string[] {
  const ids = fromTarget.flatMap((step) => {
    const id = blockId(step);
    const continues = step.type === 'agent' && step.session === 'continue';
    return continues && id !== undefined && (storedOf(run, id)?.executions ?? 0) > 0 ? [id] : [];
  });
  return [...new Set(ids)];
}

/** Reused blocks whose YAML differs from the source run's (or that have no hash there). */
function changedBlocks(
  before: Map<string, Step>,
  reused: string[],
  hashes: Record<string, string>,
): string[] {
  return reused.filter((id) => {
    const step = before.get(id);
    return !step || !Object.hasOwn(hashes, id) || hashes[id] !== blockHash(step);
  });
}

/** What "Run from here" will do when `run` is continued at `stepId` with the workflow as it is now. */
export function resumePreview(workflow: Workflow, run: RunView, stepId: string): ResumePreview {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const path = resumePath(steps, stepId);
  if (!path) return blocked(run.runId, stepId, BLOCKERS.missing);
  if (run.status === 'running') return blocked(run.runId, stepId, BLOCKERS.running);
  if (run.simulated) return blocked(run.runId, stepId, BLOCKERS.simulated);

  const { before, fromTarget } = splitAtTarget(steps, path);
  const output = (id: string) => storedOf(run, id)?.output;
  const reused = [...before.keys()].filter((id) => output(id) !== undefined);
  const hashes = run.blockHashes;
  return {
    runId: run.runId,
    stepId,
    reused,
    changed: hashes ? changedBlocks(before, reused, hashes) : [],
    missing: [...before.keys()].filter((id) => output(id) === undefined),
    trimmed: reused.filter((id) => storedOf(run, id)?.outputTrimmed === true),
    masked: reused.filter((id) => containsMask(output(id))),
    changesUnknown: !hashes,
    loops: loopPoints(run, path),
    forcedBranches: forcedBranches(run, path),
    freshSessions: freshSessions(run, fromTarget),
  };
}

/** Engine options to continue `run` at `stepId`; throws the preview's blocker when it can't be continued. */
export function resumeOptions(workflow: Workflow, run: RunView, stepId: string): ResumeOptions {
  const preview = resumePreview(workflow, run, stepId);
  if (preview.blocker !== undefined) throw new Error(preview.blocker);
  const outputs = Object.entries(run.steps).flatMap(([id, step]): [string, StepOutput][] =>
    step.output ? [[id, step.output]] : [],
  );
  return {
    fromRunId: run.runId,
    stepId,
    outputs: Object.fromEntries(outputs),
    loopIterations: Object.fromEntries(preview.loops.map((loop) => [loop.stepId, loop.iteration])),
    ...(run.blockHashes && { blockHashes: { ...run.blockHashes } }),
  };
}

/**
 * The block where a run stopped: of the failed or cancelled blocks that ran in it (reused ones don't count), the
 * one whose latest execution started last; on equal start times the later one in `run.steps`.
 */
export function runStoppedAt(run: RunView): string | undefined {
  let stoppedAt: string | undefined;
  let latest = -Infinity;
  for (const [id, step] of Object.entries(run.steps)) {
    if (step.reused || (step.status !== 'failure' && step.status !== 'cancelled')) continue;
    const startedAt = step.startedAt ?? -Infinity;
    if (stoppedAt === undefined || startedAt >= latest) {
      stoppedAt = id;
      latest = startedAt;
    }
  }
  return stoppedAt;
}
