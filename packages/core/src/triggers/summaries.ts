import type { TriggerKind } from '../schema/types';
import { formatEvery, parseDuration } from './duration';
import type { TriggerSummary } from './types';

/** Patterns a label shows before it counts the rest ("and 2 more"). */
const MAX_LABEL_PATTERNS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPattern = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** `files` as a list of usable patterns: one pattern becomes a list, anything that isn't a pattern is dropped. */
function patternsOf(trigger: unknown): string[] {
  const files = isRecord(trigger) ? trigger.files : undefined;
  if (typeof files === 'string') return isPattern(files) ? [files] : [];
  return Array.isArray(files) ? files.filter(isPattern) : [];
}

function patternList(files: string[]): string {
  const shown = files.slice(0, MAX_LABEL_PATTERNS).join(', ');
  const more = files.length - MAX_LABEL_PATTERNS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

const FILE_LABELS: Record<Exclude<TriggerKind, 'schedule'>, string> = {
  save: 'On save',
  change: 'On change',
};

function scheduleSummary(trigger: unknown): TriggerSummary | undefined {
  const every = isRecord(trigger) ? trigger.every : undefined;
  if (typeof every !== 'string' && typeof every !== 'number') return undefined;
  const written = String(every);
  if (written.trim() === '') return undefined;
  const everyMs = parseDuration(written);
  return everyMs === undefined
    ? { kind: 'schedule', label: `Every ${written}`, every: written }
    : { kind: 'schedule', label: formatEvery(everyMs), every: written, everyMs };
}

/**
 * The triggers of a workflow's `on:` as the UI shows them, in the order save, change, schedule. Reads lenient
 * (possibly malformed) workflows: triggers without usable patterns or duration are left out.
 */
export function triggerSummaries(on: unknown): TriggerSummary[] {
  if (!isRecord(on)) return [];
  const summaries: TriggerSummary[] = [];
  for (const kind of ['save', 'change'] as const) {
    const files = Object.hasOwn(on, kind) ? patternsOf(on[kind]) : [];
    if (files.length > 0)
      summaries.push({ kind, label: `${FILE_LABELS[kind]}: ${patternList(files)}`, files });
  }
  const schedule = Object.hasOwn(on, 'schedule') ? scheduleSummary(on.schedule) : undefined;
  if (schedule) summaries.push(schedule);
  return summaries;
}
