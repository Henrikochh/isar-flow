import { shapeToJsonSchema } from './agent/json';
import type { Step, StepSlot, StepType, Workflow } from './schema/types';

export type OutputType = 'string' | 'number' | 'boolean' | 'object' | 'list' | 'any';

export interface OutputInfo {
  /** Dot path below `steps.<id>`, e.g. 'exitCode' or 'usage.inputTokens'. */
  key: string;
  type: OutputType;
  description: string;
}

const COMMON_OUTPUTS: OutputInfo[] = [
  {
    key: 'status',
    type: 'string',
    description: 'How the block ended: success, failure, skipped or cancelled',
  },
  { key: 'durationMs', type: 'number', description: 'How long the block ran, in milliseconds' },
];

export const STEP_OUTPUTS: Record<StepType, OutputInfo[]> = {
  agent: [
    { key: 'text', type: 'string', description: 'Final answer of the agent' },
    { key: 'json', type: 'any', description: 'Answer parsed as JSON (only with output format JSON)' },
    { key: 'model', type: 'string', description: 'Model that answered (may be a fallback model)' },
    { key: 'usage.inputTokens', type: 'number', description: 'Input tokens used' },
    { key: 'usage.outputTokens', type: 'number', description: 'Output tokens used' },
    { key: 'turns', type: 'number', description: 'Number of model round-trips' },
    ...COMMON_OUTPUTS,
  ],
  console: [
    { key: 'exitCode', type: 'number', description: 'Exit code of the command (0 means success)' },
    { key: 'stdout', type: 'string', description: 'Standard output of the command' },
    { key: 'stderr', type: 'string', description: 'Error output of the command' },
    { key: 'output', type: 'string', description: 'Standard and error output in the order they arrived' },
    { key: 'timedOut', type: 'boolean', description: 'True when the command was stopped by its timeout' },
    ...COMMON_OUTPUTS,
  ],
  loop: [
    { key: 'iterations', type: 'number', description: 'Number of iterations that ran' },
    {
      key: 'exitReason',
      type: 'string',
      description: 'Why the loop ended: condition, maxIterations or break',
    },
    ...COMMON_OUTPUTS,
  ],
  if: [
    { key: 'branch', type: 'string', description: 'Branch that ran: then or else' },
    { key: 'result', type: 'boolean', description: 'Result of the condition' },
    ...COMMON_OUTPUTS,
  ],
  break: [...COMMON_OUTPUTS],
  stop: [...COMMON_OUTPUTS],
  approval: [
    { key: 'approved', type: 'boolean', description: 'True when the run was approved' },
    { key: 'comment', type: 'string', description: 'Comment entered with the decision' },
    ...COMMON_OUTPUTS,
  ],
};

export interface VariableInfo {
  /** Expression without `${{ }}`, e.g. 'steps.tests.exitCode'. */
  expression: string;
  /** Short text for the picker: the expression, without the `steps.` prefix for block outputs. */
  label: string;
  description: string;
  type: OutputInfo['type'];
  group: 'inputs' | 'steps' | 'loop' | 'workflow' | 'env' | 'run';
  /** Block that produces the value (group 'steps' only). */
  stepId?: string;
}

/** A block of a workflow with its position; built defensively because lenient models may be malformed. */
export interface BlockNode {
  step: Step;
  /** Undefined when the block has no usable id. */
  id?: string;
  /** Path into the YAML document, e.g. ['steps', 1, 'then', 0]. */
  path: (string | number)[];
  /** Position in depth-first document order. */
  order: number;
  /** Containers from the root down to the parent. */
  ancestors: BlockNode[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childSlots(step: Step): StepSlot[] {
  if (step.type === 'loop') return ['steps'];
  if (step.type === 'if') return ['then', 'else'];
  return [];
}

/** All blocks in document order, skipping entries that are not mappings. */
export function listBlocks(workflow: Workflow): BlockNode[] {
  const blocks: BlockNode[] = [];
  const visit = (list: unknown, path: (string | number)[], ancestors: BlockNode[]) => {
    if (!Array.isArray(list)) return;
    list.forEach((item: unknown, index) => {
      if (!isRecord(item)) return;
      const step = item as unknown as Step;
      const node: BlockNode = { step, path: [...path, index], order: blocks.length, ancestors };
      if (typeof item.id === 'string' && item.id !== '') node.id = item.id;
      blocks.push(node);
      for (const slot of childSlots(step)) visit(item[slot], [...node.path, slot], [...ancestors, node]);
    });
  };
  visit(isRecord(workflow) ? workflow.steps : undefined, ['steps'], []);
  return blocks;
}

/** True when the blocks sit in different branches (then/else) of the same if block. */
export function inDifferentBranches(a: BlockNode, b: BlockNode): boolean {
  // Paths alternate slot and index: ['steps', 1, 'then', 0, ...].
  for (let i = 0; i < Math.min(a.path.length, b.path.length); i += 2) {
    if (a.path[i] !== b.path[i]) return true;
    if (a.path[i + 1] !== b.path[i + 1]) return false;
  }
  return false;
}

/** Whether loop variables (and the loop's own scope) apply: inside a loop body or in a loop's own condition. */
export function hasLoopScope(node: BlockNode): boolean {
  return node.step.type === 'loop' || node.ancestors.some((a) => a.step.type === 'loop');
}

/**
 * Whether `block` has run (and its outputs are set) when `from` runs. `from` null means after the
 * whole workflow. Inside a loop body every block of that body holds the value of its latest execution;
 * a loop's own condition can read its body.
 */
export function canReadBlock(from: BlockNode | null, block: BlockNode): boolean {
  if (from === null) return true;
  // The engine marks the branch that is not taken as skipped before it runs the other one, so even
  // inside a loop the other branch never holds a previous iteration's values.
  if (inDifferentBranches(block, from)) return false;
  const loops = [...from.ancestors, from].filter((n) => n.step.type === 'loop');
  if (loops.some((l) => block.ancestors.includes(l))) return true;
  return block.order < from.order && !from.ancestors.includes(block);
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z0-9_$]+)*$/;

/** Appends a property access, using brackets when the name is not readable as an identifier. */
export function memberAccess(base: string, name: string): string {
  if (IDENTIFIER.test(name)) return `${base}.${name}`;
  return `${base}['${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

const SCHEMA_TYPES: Record<string, OutputType> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  object: 'object',
  array: 'list',
};

/** Type of a JSON Schema; optional compact keys become `[type, 'null']`, which still reads as `type`. */
function schemaType(schema: unknown): OutputType {
  if (!isRecord(schema)) return 'any';
  const declared: unknown[] = Array.isArray(schema.type)
    ? schema.type
    : schema.type === undefined
      ? []
      : [schema.type];
  const types = declared.filter((t) => t !== 'null');
  if (types.length === 1 && typeof types[0] === 'string' && Object.hasOwn(SCHEMA_TYPES, types[0]))
    return SCHEMA_TYPES[types[0]];
  return types.length === 0 && isRecord(schema.properties) ? 'object' : 'any';
}

const MAX_SHAPE_DEPTH = 3;

function schemaFields(schema: unknown, depth = 0): { path: string[]; type: OutputType }[] {
  if (!isRecord(schema) || !isRecord(schema.properties) || depth >= MAX_SHAPE_DEPTH) return [];
  return Object.entries(schema.properties).flatMap(([name, sub]) => [
    { path: [name], type: schemaType(sub) },
    ...schemaFields(sub, depth + 1).map((f) => ({ path: [name, ...f.path], type: f.type })),
  ]);
}

function stepVariable(id: string, key: string[], type: OutputType, description: string): VariableInfo {
  return {
    expression: [id, ...key].reduce(memberAccess, 'steps'),
    label: key.reduce(memberAccess, id),
    description,
    type,
    group: 'steps',
    stepId: id,
  };
}

function blockVariables(node: BlockNode): VariableInfo[] {
  const { step, id } = node;
  if (!id || !Object.hasOwn(STEP_OUTPUTS, step.type)) return [];
  const output = step.type === 'agent' && isRecord(step.output) ? step.output : undefined;
  const vars: VariableInfo[] = [];
  for (const info of STEP_OUTPUTS[step.type]) {
    if (info.key !== 'json') {
      vars.push(stepVariable(id, info.key.split('.'), info.type, info.description));
      continue;
    }
    if (output?.format !== 'json') continue;
    // Read the shape the way the agent runtime does (optional `key?`, `type?`, compact vs. JSON Schema).
    const schema = isRecord(output.schema) ? shapeToJsonSchema(output.schema) : undefined;
    vars.push(stepVariable(id, ['json'], schemaType(schema), info.description));
    for (const field of schemaFields(schema)) {
      const description = `Field '${field.path.join('.')}' of the JSON answer`;
      vars.push(stepVariable(id, ['json', ...field.path], field.type, description));
    }
  }
  return vars;
}

function inputVariables(workflow: Workflow): VariableInfo[] {
  if (!isRecord(workflow.inputs)) return [];
  return Object.entries(workflow.inputs).map(([name, input]) => {
    const declared = isRecord(input) ? input : {};
    const type = declared.type === 'number' || declared.type === 'boolean' ? declared.type : 'string';
    const description =
      typeof declared.description === 'string' && declared.description !== ''
        ? declared.description
        : 'Value entered when the run starts';
    const expression = memberAccess('inputs', name);
    return { expression, label: expression, description, type, group: 'inputs' } satisfies VariableInfo;
  });
}

function envVariables(workflow: Workflow): VariableInfo[] {
  if (!isRecord(workflow.env)) return [];
  return Object.keys(workflow.env).map((name) => {
    const expression = memberAccess('env', name);
    const description = 'Environment variable set by the workflow';
    return {
      expression,
      label: expression,
      description,
      type: 'string',
      group: 'env',
    } satisfies VariableInfo;
  });
}

const fixed = (
  expression: string,
  description: string,
  type: OutputType,
  group: VariableInfo['group'],
): VariableInfo => ({
  expression,
  label: expression,
  description,
  type,
  group,
});

const LOOP_VARIABLES: VariableInfo[] = [
  fixed('loop.iteration', 'Current iteration of the innermost loop, starting at 1', 'number', 'loop'),
  fixed('loop.index', 'Current iteration of the innermost loop, starting at 0', 'number', 'loop'),
];

const WORKFLOW_VARIABLES: VariableInfo[] = [
  fixed('workflow.name', 'Name of this workflow', 'string', 'workflow'),
  fixed('workflow.file', 'Path of the workflow file', 'string', 'workflow'),
  fixed('workspace.root', 'Folder of the workspace the run belongs to', 'string', 'workflow'),
];

const RUN_VARIABLES: VariableInfo[] = [fixed('run.id', 'Unique id of the current run', 'string', 'run')];

/**
 * Variables usable inside block `stepId` (null = after the whole workflow), grouped as
 * inputs, steps, loop, workflow, env, run. Unknown block ids only get workflow-level variables.
 */
export function availableVariables(workflow: Workflow, stepId: string | null): VariableInfo[] {
  const blocks = listBlocks(workflow);
  const from = stepId === null ? null : blocks.find((b) => b.id === stepId);
  const vars: VariableInfo[] = [...inputVariables(workflow)];
  if (from !== undefined) {
    for (const block of blocks) if (canReadBlock(from, block)) vars.push(...blockVariables(block));
    if (from && hasLoopScope(from)) vars.push(...LOOP_VARIABLES);
  }
  vars.push(...WORKFLOW_VARIABLES, ...envVariables(workflow), ...RUN_VARIABLES);
  const seen = new Set<string>();
  return vars.filter((v) => !seen.has(v.expression) && seen.add(v.expression));
}
