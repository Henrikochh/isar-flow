import { SECRET_MASK } from '../engine/mask';
import { analyzeExpression, evaluateExpression, type ExpressionContext, stringifyValue } from '../expr';
import type { LiveContext, LiveValue, LiveValueType } from '../run/types';
import { findStep } from '../schema/steps';
import type { Workflow } from '../schema/types';
import { cutText, isCutString, LIVE_VALUE_MAX_CHARS } from './context';

/** Where the expression is written: `loop.*` reads the innermost loop that contains this block. */
export interface LiveValueScope {
  workflow?: Workflow | null;
  stepId?: string | null;
}

const ENV_UNAVAILABLE = "Environment values aren't saved with runs.";
const LOOP_UNAVAILABLE = 'loop is only set inside a loop.';
const ROOT_UNAVAILABLE = {
  editor: "This run didn't record editor values.",
  git: "This run didn't record git values.",
};
/** Guards the walk for cut strings against deeply nested or cyclic data. */
const MAX_DEPTH = 64;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Id of the innermost loop that contains the block, or the block itself when it is a loop. */
function innermostLoop(scope: LiveValueScope | undefined): string | undefined {
  const { workflow, stepId } = scope ?? {};
  if (!workflow || !stepId) return undefined;
  const visit = findStep(workflow.steps ?? [], stepId);
  if (!visit) return undefined;
  return [...visit.ancestors, visit.step].filter((step) => step.type === 'loop').at(-1)?.id;
}

function unavailableReason(
  context: LiveContext,
  references: string[][],
  loopId: string | undefined,
): string | undefined {
  if (references.some(([root]) => root === 'env')) return ENV_UNAVAILABLE;
  for (const root of ['editor', 'git'] as const) {
    if (!context[root] && references.some(([name]) => name === root)) return ROOT_UNAVAILABLE[root];
  }
  for (const [root, id] of references) {
    if (root === 'steps' && id !== undefined && !Object.hasOwn(context.steps, id)) {
      return `${id} has no result in this run.`;
    }
  }
  if (!references.some(([root]) => root === 'loop')) return undefined;
  if (loopId === undefined) return LOOP_UNAVAILABLE;
  return Object.hasOwn(context.loops, loopId) ? undefined : `${loopId} has no result in this run.`;
}

function containsCut(value: unknown, depth = 0): boolean {
  if (isCutString(value)) return true;
  if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) return false;
  return Object.values(value).some((item) => containsCut(item, depth + 1));
}

/** The value a reference reads, as far as it leads; property reads on text (length, index) keep the text. */
function referencedValue(ctx: ExpressionContext, path: string[]): unknown {
  let current: unknown = ctx;
  for (const key of path) {
    if (typeof current === 'string') return current;
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function typeOf(value: unknown): LiveValueType {
  if (value === null || value === undefined || value === '') return 'empty';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'string':
      return 'text';
    case 'number':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

/**
 * Value of a `${{ … }}` expression (the source between the braces) in a run's context. Environment values are
 * never available; secrets show as the mask; long values are cut at 2,048 characters.
 */
export function liveValue(context: LiveContext, expression: string, scope?: LiveValueScope): LiveValue {
  let references: string[][];
  try {
    references = analyzeExpression(expression).references;
  } catch (error) {
    return { kind: 'error', message: errorText(error) };
  }
  const loopId = innermostLoop(scope);
  const reason = unavailableReason(context, references, loopId);
  if (reason !== undefined) return { kind: 'unavailable', message: reason };

  const ctx: ExpressionContext = {
    inputs: context.inputs,
    steps: context.steps,
    env: {},
    secrets: Object.fromEntries(context.secrets.map((name) => [name, SECRET_MASK])),
    workflow: context.workflow,
    workspace: context.workspace,
    run: { id: context.runId },
    loop: loopId === undefined ? undefined : context.loops[loopId],
    editor: context.editor,
    git: context.git,
  };
  let result: unknown;
  try {
    result = evaluateExpression(expression, ctx);
  } catch (error) {
    return { kind: 'error', message: errorText(error) };
  }
  const full = stringifyValue(result);
  const text = cutText(full, LIVE_VALUE_MAX_CHARS);
  const truncated =
    text.length < full.length ||
    containsCut(result) ||
    references.some((path) => containsCut(referencedValue(ctx, path)));
  return { kind: 'value', text, type: typeOf(result), truncated, masked: text.includes(SECRET_MASK) };
}
