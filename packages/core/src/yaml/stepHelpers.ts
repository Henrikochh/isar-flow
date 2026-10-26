import type { Step, StepType, Workflow } from '../schema/types';

const SLOTS = ['steps', 'then', 'else'] as const;

/**
 * Every block id in document order, nested blocks included. Blocks without a string id are skipped. Lists are
 * followed for any block, not only loop/if, so ids hidden under a mistyped `type` count as taken, exactly as
 * in the edit operations.
 */
export function collectStepIds(workflow: Workflow | null | undefined): string[] {
  const ids: string[] = [];
  const visit = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list as unknown[]) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const block = item as Record<string, unknown>;
      if (typeof block.id === 'string') ids.push(block.id);
      for (const slot of SLOTS) visit(block[slot]);
    }
  };
  visit(workflow?.steps);
  return ids;
}

/** `<type>_<n>` with the smallest n ≥ 1 that no block in the workflow uses yet. */
export function nextStepId(workflow: Workflow | null | undefined, type: StepType): string {
  const used = new Set(collectStepIds(workflow));
  let n = 1;
  while (used.has(`${type}_${n}`)) n++;
  return `${type}_${n}`;
}

/** A new block as the canvas inserts it: schema-valid with sensible starting values. */
export function createDefaultStep(type: StepType, id: string): Step {
  switch (type) {
    case 'agent':
      return { id, type, prompt: '' };
    case 'console':
      return { id, type, run: 'echo "Hello from Isar Flow"' };
    case 'loop':
      return { id, type, maxIterations: 5, steps: [] };
    case 'if':
      return { id, type, condition: '${{ true }}', then: [], else: [] };
    case 'break':
      return { id, type };
    case 'stop':
      return { id, type, outcome: 'failure' };
    case 'approval':
      return { id, type, message: 'Continue?' };
  }
}
