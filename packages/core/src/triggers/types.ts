import type { TriggerKind } from '../schema/types';

/**
 * One trigger of a workflow's `on:` as the UI shows it (canvas Start marker, status bar, sidebar), built by
 * `triggerSummaries(workflow.on)` in core.
 */
export interface TriggerSummary {
  kind: TriggerKind;
  /** Short text, e.g. "On save: src/*.ts", "On change: docs/**", "Every 15 min". */
  label: string;
  /** save and change: the patterns as a list (`!` exclusions included). */
  files?: string[];
  /** schedule: the duration as written, e.g. "1h30m". */
  every?: string;
  /** schedule: the duration in milliseconds; undefined when it can't be parsed. */
  everyMs?: number;
}
