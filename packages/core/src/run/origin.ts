import type { RunOrigin } from '../engine/types';

/** How the history shows a run's origin: a chip, a sentence for details and a codicon name. */
export interface RunOriginText {
  /** Short label, e.g. "On save". */
  chip: string;
  /** e.g. "Started on save of src/app.ts". */
  sentence: string;
  /** Codicon name without the `codicon-` prefix. */
  icon: string;
}

const fileOf = (origin: { file?: unknown }): string | undefined =>
  typeof origin.file === 'string' && origin.file !== '' ? origin.file : undefined;

function triggerText(origin: Extract<RunOrigin, { kind: 'trigger' }>): RunOriginText | undefined {
  const file = fileOf(origin);
  switch (origin.trigger) {
    case 'save':
      return {
        chip: 'On save',
        sentence: file ? `Started on save of ${file}` : 'Started on save',
        icon: 'save',
      };
    case 'change':
      return {
        chip: 'On change',
        sentence: file ? `Started by a change to ${file}` : 'Started by a file change',
        icon: 'file',
      };
    case 'schedule':
      return { chip: 'Scheduled', sentence: 'Started by its schedule', icon: 'watch' };
    default:
      return undefined;
  }
}

/** Text for how a run was started; undefined for manual runs and origins this version doesn't know. */
export function runOriginText(origin: RunOrigin | undefined): RunOriginText | undefined {
  if (typeof origin !== 'object' || origin === null) return undefined;
  switch (origin.kind) {
    case 'trigger':
      return triggerText(origin);
    case 'copilot':
      return { chip: 'Copilot', sentence: 'Started by Copilot', icon: 'copilot' };
    case 'selection':
      return { chip: 'Selection', sentence: 'Started on a selection', icon: 'selection' };
    case 'cli':
      return { chip: 'Command line', sentence: 'Started from the command line', icon: 'terminal' };
    default:
      return undefined;
  }
}
