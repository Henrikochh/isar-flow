/** Words for a workflow's triggers on the Start marker: chip icons and tooltips, and the one status line. */
import type { TriggerKind, TriggerSummary, WorkflowTriggerState } from '@isar-flow/core';
import { formatRelativeTime } from '../../../hooks';

export const TRIGGER_ICONS: Record<TriggerKind, string> = { save: 'save', change: 'file', schedule: 'watch' };

/** Tooltip of a trigger chip with every pattern (the chip's label shortens long lists). */
export function triggerTitle(trigger: TriggerSummary): string {
  if (trigger.kind === 'schedule') return `Runs ${trigger.label.toLowerCase()} while VS Code is open`;
  const files = trigger.files ?? [];
  const included = files.filter((file) => !file.startsWith('!'));
  const excluded = files.filter((file) => file.startsWith('!')).map((file) => file.slice(1));
  const matching = included.length ? `a file matching ${included.join(', ')}` : 'a file';
  const except = excluded.length ? `, except ${excluded.join(', ')}` : '';
  return trigger.kind === 'save'
    ? `Runs when you save ${matching}${except}`
    : `Runs when ${matching} changes on disk${except}`;
}

/** "in 12 min", "in 3 h", "in 2 d"; "in less than a minute" when it is due. */
export function formatIn(ms: number): string {
  if (ms < 45_000) return 'in less than a minute';
  if (ms < 90 * 60_000) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 36 * 3_600_000) return `in ${Math.round(ms / 3_600_000)} h`;
  return `in ${Math.round(ms / 86_400_000)} d`;
}

function cause(kind: TriggerKind, file: string | undefined): string {
  switch (kind) {
    case 'save':
      return file ? `on save of ${file}` : 'on save';
    case 'change':
      return file ? `by a change to ${file}` : 'by a file change';
    default:
      return 'by its schedule';
  }
}

/** The muted line under active triggers: the next scheduled run, else what the last trigger did. */
export function triggerStatusLine(state: WorkflowTriggerState, now: number): string | undefined {
  if (state.status !== 'active') return undefined;
  if (typeof state.nextRunAt === 'number') return `Next run ${formatIn(state.nextRunAt - now)}`;
  const last = state.lastFired;
  if (!last || typeof last.at !== 'number') return undefined;
  const when = `${cause(last.kind, last.file)} ${formatRelativeTime(last.at, now)}`;
  return last.skipped ? `Not started ${when}. ${last.skipped}` : `Last started ${when}`;
}
