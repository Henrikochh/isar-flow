import type { StepOutput } from '../engine/types';
import type { RunView, StepRunView } from '../run/types';
import type { StepType, Workflow } from '../schema/types';
import { code, escapeText } from './format';

export type BlockState =
  'success' | 'failure' | 'cancelled' | 'running' | 'pending' | 'skipped' | 'reused' | 'not-run';

/** One block of the report in timeline order. */
export interface ReportBlock {
  id: string;
  /** Name from the workflow, if it has one other than the id. */
  name?: string;
  /** From the workflow, else guessed from the block's output; undefined when unknown. */
  type?: StepType;
  /** Nesting level in the workflow (0 = top level). */
  depth: number;
  state: BlockState;
  view?: StepRunView;
  /** In the run but not in the workflow anymore. */
  removed?: boolean;
}

export const STATE_LABELS: Record<BlockState, string> = {
  success: 'Succeeded',
  failure: 'Failed',
  cancelled: 'Cancelled',
  running: 'Running',
  pending: 'Waiting',
  skipped: 'Skipped',
  reused: 'Reused',
  'not-run': 'Not run',
};

const STEP_TYPES: readonly StepType[] = [
  'agent',
  'console',
  'loop',
  'if',
  'break',
  'stop',
  'approval',
  'ask',
];

interface WorkflowBlock {
  id: string;
  name?: string;
  type?: StepType;
  depth: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Blocks of a (possibly lenient) workflow in document order; entries without an id are skipped. */
function workflowBlocks(workflow: Workflow | null | undefined): WorkflowBlock[] {
  const blocks: WorkflowBlock[] = [];
  const seen = new Set<string>();
  const visit = (list: unknown, depth: number) => {
    if (!Array.isArray(list)) return;
    for (const step of list) {
      if (!isRecord(step)) continue;
      if (typeof step.id === 'string' && step.id !== '' && !seen.has(step.id)) {
        seen.add(step.id);
        const type = STEP_TYPES.find((t) => t === step.type);
        const name = typeof step.name === 'string' && step.name.trim() !== '' ? step.name.trim() : undefined;
        blocks.push({
          id: step.id,
          depth,
          ...(name !== undefined && name !== step.id && { name }),
          ...(type && { type }),
        });
      }
      if (step.type === 'loop') visit(step.steps, depth + 1);
      if (step.type === 'if') {
        visit(step.then, depth + 1);
        visit(step.else, depth + 1);
      }
    }
  };
  visit(isRecord(workflow) ? workflow.steps : undefined, 0);
  return blocks;
}

/** The block type its output suggests, for runs whose workflow is not known (or blocks removed from it). */
function guessType(output: StepOutput | undefined): StepType | undefined {
  if (!output) return undefined;
  if ('exitCode' in output) return 'console';
  if ('text' in output || 'json' in output || 'model' in output) return 'agent';
  if ('approved' in output) return 'approval';
  if ('answer' in output) return 'ask';
  if ('iterations' in output || 'exitReason' in output) return 'loop';
  if ('branch' in output) return 'if';
  return undefined;
}

function stateOf(view: StepRunView | undefined): BlockState {
  if (!view) return 'not-run';
  if (view.reused) return 'reused';
  if (view.status === 'pending' && view.executions === 0) return 'not-run';
  return view.status;
}

/**
 * Blocks in workflow document order (nested blocks indented), then blocks of the run that are not in the workflow
 * anymore; without a workflow the run's block order (order of first start).
 */
export function reportBlocks(run: RunView, workflow: Workflow | null | undefined): ReportBlock[] {
  const steps = isRecord(run.steps) ? run.steps : {};
  const view = (id: string) => (Object.hasOwn(steps, id) ? steps[id] : undefined);
  const known = workflowBlocks(workflow);
  const ids = new Set(known.map((block) => block.id));
  const blocks: ReportBlock[] = known.map((block) => {
    const current = view(block.id);
    const type = block.type ?? guessType(current?.output);
    return {
      id: block.id,
      depth: block.depth,
      state: stateOf(current),
      ...(block.name !== undefined && { name: block.name }),
      ...(type && { type }),
      ...(current && { view: current }),
    };
  });
  for (const [id, current] of Object.entries(steps)) {
    if (ids.has(id)) continue;
    const type = guessType(current.output);
    blocks.push({
      id,
      depth: 0,
      state: stateOf(current),
      view: current,
      ...(type && { type }),
      ...(known.length > 0 && { removed: true }),
    });
  }
  return blocks;
}

/** "Run tests (`tests`)" or "`tests`", as Markdown. */
export function blockLabel(block: Pick<ReportBlock, 'id' | 'name'>): string {
  return block.name ? `${escapeText(block.name)} (${code(block.id)})` : code(block.id);
}

/** Blocks that ran in this run (not reused, skipped or never started). */
export function executed(block: ReportBlock): boolean {
  return (
    block.state === 'success' ||
    block.state === 'failure' ||
    block.state === 'cancelled' ||
    block.state === 'running'
  );
}
