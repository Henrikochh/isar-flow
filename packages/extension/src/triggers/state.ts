import type { TriggerPauseReason, TriggerSummary, WorkflowTriggerState } from '@isar-flow/core';

/** The storm guard: more save or change starts than this within STORM_WINDOW_MS pause the triggers. */
export const STORM_LIMIT = 10;
export const STORM_WINDOW_MS = 10 * 60_000;

export const SETTING_SECTION = 'isarFlow';
export const ENABLED_SETTING = 'triggers.enabled';

export const DISABLED_MESSAGE = 'Triggers are turned off in the settings (isarFlow.triggers.enabled).';
export const UNTRUSTED_MESSAGE =
  'Triggers only run in trusted workspaces. Trust this workspace to turn them on.';
export const INVALID_MESSAGE = 'The workflow has problems. Fix them to turn its triggers on.';
export const RUNNING_MESSAGE = 'The workflow was already running.';

export const approvalMessage = (name: string) =>
  `Run '${name}' once and choose 'Run and remember' so its triggers can start it.`;
/** A workflow with nothing to confirm that no person has started yet. */
export const firstRunMessage = (name: string) => `Run '${name}' once so its triggers can start it.`;
export const stormWarning = (name: string) =>
  `'${name}' started ${STORM_LIMIT} times in ${STORM_WINDOW_MS / 60_000} minutes, so its triggers are paused.`;
const limitedMessage = (name: string) => `${stormWarning(name)} Resume them when you're ready.`;

/** What the state of one workflow's triggers depends on. */
export interface TriggerStateInput {
  name: string;
  triggers: TriggerSummary[];
  /** The setting isarFlow.triggers.enabled. */
  enabled: boolean;
  trusted: boolean;
  /** From the workflow list (the file parses and validates). */
  valid: boolean;
  /** The run manager found problems when a trigger fired. */
  invalidAtFire: boolean;
  limited: boolean;
  /** Set while its commands need approval: the sentence to show. */
  approval?: string;
  /** Set while a required input has no default: the sentence to show. */
  inputs?: string;
  nextRunAt?: number;
  lastFired?: WorkflowTriggerState['lastFired'];
}

/** The first gate that keeps the triggers from starting runs, in the order they are checked. */
export function pauseOf(
  input: TriggerStateInput,
): { reason: TriggerPauseReason; message: string } | undefined {
  if (!input.enabled) return { reason: 'disabled', message: DISABLED_MESSAGE };
  if (!input.trusted) return { reason: 'untrusted', message: UNTRUSTED_MESSAGE };
  if (!input.valid || input.invalidAtFire) return { reason: 'invalid', message: INVALID_MESSAGE };
  if (input.limited) return { reason: 'limited', message: limitedMessage(input.name) };
  if (input.approval) return { reason: 'approval', message: input.approval };
  if (input.inputs) return { reason: 'inputs', message: input.inputs };
  return undefined;
}

export function triggerStateOf(input: TriggerStateInput): WorkflowTriggerState {
  const pause = pauseOf(input);
  const state: WorkflowTriggerState = pause
    ? { triggers: input.triggers, status: 'paused', pausedReason: pause.reason, pausedMessage: pause.message }
    : { triggers: input.triggers, status: 'active' };
  if (!pause && input.nextRunAt !== undefined) state.nextRunAt = input.nextRunAt;
  if (input.lastFired) state.lastFired = input.lastFired;
  return state;
}
