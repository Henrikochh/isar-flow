import type { RunOrigin, Workflow } from '@isar-flow/core';
import type { RunRefusal, RunRefusalReason } from '../contracts';

export const NOT_ALLOWED_MESSAGE = "Triggers and Copilot can't simulate or continue runs.";
export const NOT_CONFIRMED_MESSAGE = "The commands weren't confirmed.";
export const CANCELLED_MESSAGE = 'The run was cancelled before it started.';
export const STARTING_MESSAGE = 'This workflow is already starting.';
export const STOPPED_MESSAGE = 'Isar Flow is shutting down, so the workflow did not start.';

export interface RefusalNotice {
  kind: 'info' | 'warning' | 'error';
  /** Button label → action. */
  buttons?: Record<string, () => unknown>;
}

/**
 * Why a start stopped. Callers with RunStartOptions.onRefused get reason and message; the others see `notice`
 * (none: the person already knows, e.g. a dialog they cancelled).
 */
export class StartRefusal implements RunRefusal {
  constructor(
    readonly reason: RunRefusalReason,
    readonly message: string,
    readonly notice?: RefusalNotice,
  ) {}
}

/** Triggers and Copilot start runs without anyone at the keyboard: they never show input boxes. */
export function neverPrompts(origin: RunOrigin): boolean {
  return origin.kind === 'trigger' || origin.kind === 'copilot';
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** Why a run that can't prompt is missing a value: the first required input without default and value. */
export function missingInputMessage(
  workflow: Workflow,
  values: Record<string, unknown>,
  origin: RunOrigin,
): string | undefined {
  for (const [name, input] of Object.entries(workflow.inputs ?? {})) {
    if (!input.required || input.default !== undefined || !isEmpty(values[name])) continue;
    const fix =
      origin.kind === 'trigger'
        ? "Triggers can't ask for values: give it a default."
        : 'Pass it when you run the workflow.';
    return `Input '${name}' is required. ${fix}`;
  }
  return undefined;
}

export function triggerConfirmationMessage(workflowName: string): string {
  return `Run '${workflowName}' once and choose 'Run and remember' so its triggers can start it.`;
}

/** For a workflow with nothing to confirm that no person has started yet. */
export function triggerFirstRunMessage(workflowName: string): string {
  return `Run '${workflowName}' once so its triggers can start it.`;
}
