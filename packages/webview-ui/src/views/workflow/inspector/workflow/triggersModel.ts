/** Reading and editing a workflow's `on:` (lenient: whatever the YAML holds is kept unless it is edited). */
import { MIN_SCHEDULE_MS, parseDuration, type WorkflowOp } from '@isar-flow/core';

export type FileTriggerKind = 'save' | 'change';

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function onOf(workflow: unknown): Raw {
  const on = isRecord(workflow) ? workflow.on : undefined;
  return isRecord(on) ? on : {};
}

/** The patterns of a save or change trigger as a list; null when the workflow has no such trigger. */
export function patternsOf(on: Raw, kind: FileTriggerKind): string[] | null {
  if (!Object.hasOwn(on, kind)) return null;
  const files = isRecord(on[kind]) ? (on[kind] as Raw).files : undefined;
  if (typeof files === 'string') return [files];
  return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
}

/** The schedule as written; null without one. */
export function everyOf(on: Raw): string | null {
  if (!Object.hasOwn(on, 'schedule')) return null;
  const every = isRecord(on.schedule) ? on.schedule.every : undefined;
  return typeof every === 'string' || typeof every === 'number' ? String(every) : '';
}

/** `on:` with one trigger replaced (undefined removes it); the others stay as written. */
export function withTrigger(on: Raw, kind: string, value: unknown): Raw {
  const next = { ...on };
  if (value === undefined) delete next[kind];
  else next[kind] = value;
  return next;
}

/** Writes `on:`, or removes it when no trigger is left. */
export function onOp(on: Raw): WorkflowOp {
  return Object.keys(on).length
    ? { op: 'updateWorkflow', set: { on } }
    : { op: 'updateWorkflow', set: {}, unset: ['on'] };
}

/** Why a schedule can't be written as typed; nothing for an empty field (nothing is written then). */
export function everyProblem(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const ms = parseDuration(trimmed);
  if (ms === undefined) return 'Use a duration like 15m, 1h or 1h30m.';
  if (ms < MIN_SCHEDULE_MS) return 'Use 1m or more: schedules run at most once a minute.';
  return undefined;
}
