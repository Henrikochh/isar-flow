import type { Step, StepSlot, StepType } from './types';

export interface StepTypeInfo {
  type: StepType;
  label: string;
  description: string;
  /** Whether the block contains nested blocks. */
  container: boolean;
}

export const STEP_TYPE_INFO: Record<StepType, StepTypeInfo> = {
  agent: { type: 'agent', label: 'Agent', description: 'Give an agent a task and use its answer.', container: false },
  console: { type: 'console', label: 'Console', description: 'Run a command and capture its output.', container: false },
  loop: { type: 'loop', label: 'Loop', description: 'Repeat blocks until a condition is met.', container: true },
  if: { type: 'if', label: 'If / else', description: 'Branch on exit codes or answer contents.', container: true },
  break: { type: 'break', label: 'Break', description: 'Leave the surrounding loop.', container: false },
  stop: { type: 'stop', label: 'Stop', description: 'End the run as succeeded or failed.', container: false },
  approval: { type: 'approval', label: 'Approval', description: 'Pause until you approve or reject.', container: false },
};

export const STEP_TYPES = Object.keys(STEP_TYPE_INFO) as StepType[];

export interface StepChildList {
  slot: StepSlot;
  steps: Step[];
}

/** Nested step lists of a container block (empty for leaf blocks). */
export function stepChildren(step: Step): StepChildList[] {
  if (step.type === 'loop') return [{ slot: 'steps', steps: step.steps ?? [] }];
  if (step.type === 'if') return [
    { slot: 'then', steps: step.then ?? [] },
    { slot: 'else', steps: step.else ?? [] },
  ];
  return [];
}

export interface StepVisit {
  step: Step;
  parent: Step | null;
  slot: StepSlot;
  index: number;
  /** Containers from the root down to the parent. */
  ancestors: Step[];
}

/** Depth-first, document-order traversal. Return false from the visitor to skip a block's children. */
export function walkSteps(steps: Step[], visit: (v: StepVisit) => void | false): void {
  const recurse = (list: Step[], parent: Step | null, slot: StepSlot, ancestors: Step[]) => {
    list.forEach((step, index) => {
      if (visit({ step, parent, slot, index, ancestors }) === false) return;
      for (const child of stepChildren(step)) recurse(child.steps, step, child.slot, [...ancestors, step]);
    });
  };
  recurse(steps, null, 'steps', []);
}

export function findStep(steps: Step[], id: string): StepVisit | undefined {
  let found: StepVisit | undefined;
  walkSteps(steps, (v) => {
    if (found) return false;
    if (v.step.id === id) found = v;
  });
  return found;
}

export function allSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  walkSteps(steps, (v) => {
    out.push(v.step);
  });
  return out;
}
