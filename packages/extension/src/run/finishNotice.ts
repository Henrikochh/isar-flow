import type { RunOrigin, RunView } from '@isar-flow/core';

export const REVIEW_BUTTON = 'Review changes';
export const OPEN_RUN_BUTTON = 'Open run';
const MAX_ERROR_CHARS = 200;

export interface FinishNoticeInput {
  name: string;
  view: RunView;
  origin: RunOrigin;
  simulated: boolean;
  /** Files the run changed. */
  changed: number;
  /** An editor of the workflow is visible: it shows the outcome itself. */
  editorVisible: boolean;
}

export interface FinishNotice {
  kind: 'info' | 'error';
  message: string;
  /** Every button opens the run in the workflow editor. */
  buttons: string[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "0.4s", "42s", "2m 3s", "1h 5m": compact, for notifications. */
export function noticeDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** The innermost block of "Block 'a' failed: Block 'b' failed: …" and its own error. */
function failure(view: RunView): { block?: string; error?: string } {
  let error = view.error;
  let block: string | undefined;
  for (;;) {
    const match = error === undefined ? null : /^Block '([^']+)' failed: ([\s\S]*)$/.exec(error);
    if (!match) break;
    [, block, error] = match;
  }
  if (error === undefined) return { ...(block !== undefined && { block }) };
  const line = error.replace(/\s+/g, ' ').trim();
  const cut = line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…` : line;
  return { ...(block !== undefined && { block }), error: cut };
}

function changedNotice(name: string, changed: number): FinishNotice | undefined {
  if (changed <= 0) return undefined;
  return { kind: 'info', message: `${name} changed ${plural(changed, 'file')}.`, buttons: [REVIEW_BUTTON] };
}

/**
 * What to tell about a run that ended. A visible editor of the workflow shows the outcome itself, so then only
 * changed files are reported (Package A). Triggers stay quiet about successful runs without changes; Copilot runs
 * report only changed files because the chat shows the rest.
 */
export function finishNotice(input: FinishNoticeInput): FinishNotice | undefined {
  const { name, view, origin, simulated, changed } = input;
  if (simulated) {
    if (input.editorVisible || view.status === 'cancelled') return undefined;
    if (view.status === 'success') {
      return { kind: 'info', message: `Simulated run of ${name} finished.`, buttons: [OPEN_RUN_BUTTON] };
    }
    const { block } = failure(view);
    const at = block === undefined ? '' : ` at ${block}`;
    return { kind: 'error', message: `Simulated run of ${name} failed${at}.`, buttons: [OPEN_RUN_BUTTON] };
  }
  if (input.editorVisible || view.status === 'cancelled' || origin.kind === 'copilot') {
    return changedNotice(name, changed);
  }
  if (view.status === 'success') {
    if (origin.kind === 'trigger' && changed === 0) return undefined;
    const took = `${name} succeeded in ${noticeDuration(view.durationMs ?? 0)}`;
    return changed > 0
      ? {
          kind: 'info',
          message: `${took} and changed ${plural(changed, 'file')}.`,
          buttons: [REVIEW_BUTTON, OPEN_RUN_BUTTON],
        }
      : { kind: 'info', message: `${took}.`, buttons: [OPEN_RUN_BUTTON] };
  }
  const { block, error } = failure(view);
  const message =
    block !== undefined
      ? `${name} failed at ${block}${error ? `: ${error}` : '.'}`
      : `${name} failed${error ? `: ${error}` : '.'}`;
  return { kind: 'error', message, buttons: [OPEN_RUN_BUTTON] };
}
