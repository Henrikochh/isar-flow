import { type Condition, evaluateCondition, toBoolean } from '../conditions';
import { type ExpressionContext, isNumberLike, renderText, stringifyValue, toNumber } from '../expr';
import type { WorkflowInput } from '../schema/types';
import type { EditorContext, GitContext, StepOutput } from './types';

/**
 * A block failure found before the block reaches the host (bad template, unknown agent, …).
 * Retrying cannot fix it, so these are never retried.
 */
export class StepSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepSetupError';
  }
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return stringifyValue(error) || 'Unknown error';
  // Some hosts throw errors without a message; a specific name such as TimeoutError still tells the user something.
  return error.message || (error.name !== 'Error' ? error.name : '') || 'Unknown error';
}

export interface LoopVars {
  /** 1-based. */
  iteration: number;
  /** 0-based. */
  index: number;
}

/** Context roots that stay fixed for the whole run. */
export interface RunScope {
  inputs: Record<string, unknown>;
  env: Record<string, string>;
  workflow: { name: string; file: string };
  workspace: { root: string };
  run: { id: string };
  secrets: Record<string, string>;
  /** Captured at run start (RunOptions.editor/git); empty values when the run got none. */
  editor: EditorContext;
  git: GitContext;
}

export function expressionContext(
  scope: RunScope,
  steps: Record<string, StepOutput>,
  loop: LoopVars | undefined,
): ExpressionContext {
  return { ...scope, steps, loop };
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function coerceInput(name: string, def: WorkflowInput, value: unknown): unknown {
  switch (def.type) {
    case 'number':
      if (!isNumberLike(value)) {
        throw new Error(`Input '${name}' must be a number, but got '${stringifyValue(value)}'.`);
      }
      return toNumber(value);
    case 'boolean':
      return toBoolean(value);
    case 'string':
      return typeof value === 'string' ? value : stringifyValue(value);
    default:
      return value;
  }
}

/** Applies declared defaults and coerces values to the declared input types. Undeclared inputs pass through. */
export function resolveInputs(
  declared: Record<string, WorkflowInput> | undefined,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...provided };
  for (const [name, def] of Object.entries(declared ?? {})) {
    const given = Object.hasOwn(provided, name) ? provided[name] : undefined;
    const value = isMissing(given) ? def.default : given;
    if (isMissing(value)) {
      if (def.required) {
        throw new Error(`Input '${name}' is required. Provide a value when starting the run.`);
      }
      delete resolved[name];
      continue;
    }
    resolved[name] = coerceInput(name, def, value);
  }
  return resolved;
}

function wrapExpressionError<T>(field: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new StepSetupError(`Expression error in ${field}: ${errorMessage(error)}`);
  }
}

/** Renders a template field to text; failures name the field. */
export function renderField(field: string, text: string, ctx: ExpressionContext): string {
  return wrapExpressionError(field, () => renderText(text, ctx));
}

export function renderEnv(
  field: string,
  env: Record<string, string> | undefined,
  ctx: ExpressionContext,
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    rendered[key] = renderField(`${field}.${key}`, value, ctx);
  }
  return rendered;
}

export function checkCondition(field: string, condition: Condition, ctx: ExpressionContext): boolean {
  return wrapExpressionError(field, () => evaluateCondition(condition, ctx));
}
