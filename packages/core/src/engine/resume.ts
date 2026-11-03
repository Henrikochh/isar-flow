import { findStep, walkSteps } from '../schema/steps';
import type { Step } from '../schema/types';
import type { ResumeOptions, StepOutput } from './types';

/** Where a resumed run starts: the target block and the containers on the way to it. */
export interface ResumePath {
  target: Step;
  /** Containers that contain the target, outermost first. */
  ancestors: Step[];
  /** For each if among the ancestors: the branch that contains the target. */
  branches: Map<Step, 'then' | 'else'>;
}

export function resumePath(steps: Step[], stepId: string): ResumePath | undefined {
  const found = findStep(steps, stepId);
  if (!found) return undefined;
  const chain = [...found.ancestors, found.step];
  const branches = new Map<Step, 'then' | 'else'>();
  found.ancestors.forEach((ancestor, depth) => {
    if (ancestor.type !== 'if') return;
    const child = chain[depth + 1];
    branches.set(ancestor, (ancestor.then ?? []).includes(child) ? 'then' : 'else');
  });
  return { target: found.step, ancestors: found.ancestors, branches };
}

export function missingTargetError(stepId: string): string {
  return `Block '${stepId}' isn't in the workflow anymore, so the run can't continue there. Run the whole workflow instead.`;
}

/** The id of a block when it has a usable one (lenient workflows may have blocks without). */
export function blockId(step: Step): string | undefined {
  const id: unknown = step.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

export interface ResumeSplit {
  /** Blocks before the target that a resumed run reuses or misses, by id (first of duplicate ids). */
  before: Map<string, Step>;
  /** The target and every block after it, in document order. */
  fromTarget: Step[];
}

/**
 * Splits the workflow at the target in document order. Containers of the target and the branches of its ifs that
 * don't contain it (they are skipped) are not "before".
 */
export function splitAtTarget(steps: Step[], path: ResumePath): ResumeSplit {
  const before = new Map<string, Step>();
  const fromTarget: Step[] = [];
  walkSteps(steps, ({ step, parent, slot }) => {
    if (step === path.target || fromTarget.length > 0) {
      fromTarget.push(step);
      return;
    }
    const branch = parent ? path.branches.get(parent) : undefined;
    if (branch !== undefined && branch !== slot) return false;
    if (path.ancestors.includes(step)) return;
    const id = blockId(step);
    if (id !== undefined && !before.has(id)) before.set(id, step);
  });
  return { before, fromTarget };
}

/** The stored output of a block in the source run, when there is one. */
export function storedOutput(resume: ResumeOptions, step: Step): StepOutput | undefined {
  const id = blockId(step);
  return id !== undefined && Object.hasOwn(resume.outputs, id) ? resume.outputs[id] : undefined;
}

/** The iteration a loop that contains the target continues at: a whole number ≥ 1, otherwise 1. */
export function resumeIteration(resume: ResumeOptions, loop: Step): number {
  const id = blockId(loop);
  const value = id !== undefined && Object.hasOwn(resume.loopIterations, id) ? resume.loopIterations[id] : 1;
  return Number.isInteger(value) && value >= 1 ? value : 1;
}
