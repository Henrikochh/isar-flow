import {
  type LiveContext,
  type LiveValue,
  liveValue,
  parseWorkflowText,
  type Position,
  type Range,
  type RunStatus,
  templateAt,
} from '@isar-flow/core';

export interface LiveValueHover {
  markdown: string;
  /** Offsets of the template: `$` up to just after `}}`. */
  start: number;
  end: number;
}

const STATUS_WORDS: Record<RunStatus, string> = {
  running: 'running',
  success: 'succeeded',
  failure: 'failed',
  cancelled: 'cancelled',
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
function age(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 45_000) return 'just now';
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`;
  const days = Math.floor(diff / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function header(context: LiveContext, now: number): string {
  if (context.status === 'running') {
    return `**Value in the running run**${context.simulated ? ' (simulated)' : ''}`;
  }
  const details = [STATUS_WORDS[context.status], age(context.startedAt, now)];
  if (context.simulated) details.unshift('simulated');
  return `**Value in the last run** (${details.join(', ')})`;
}

/** Markdown-escapes a one-line message so ids like `fix_loop` don't turn into emphasis. */
function escapeMarkdown(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/[\\`*_[\]<>|~#]/g, '\\$&');
}

/** A code block whose fence is longer than any run of backticks in the text. */
function fenced(text: string, language: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function body(value: LiveValue): string[] {
  if (value.kind !== 'value') return [`_${escapeMarkdown(value.message)}_`];
  const parts = [
    value.text === ''
      ? '_Empty_'
      : fenced(value.text, value.type === 'list' || value.type === 'object' ? 'json' : 'text'),
  ];
  if (value.truncated) parts.push('Showing the first 2 KB.');
  if (value.masked) parts.push('Contains a secret, shown as ••••••.');
  return parts;
}

/** 0-based line and UTF-16 column of an offset. */
function positionAt(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, character: offset - (before.lastIndexOf('\n') + 1) };
}

const compare = (a: Position, b: Position) => a.line - b.line || a.character - b.character;

/** The innermost block whose YAML range contains the position (nested blocks start later). */
export function blockAt(stepRanges: Record<string, Range>, position: Position): string | undefined {
  let found: { id: string; range: Range } | undefined;
  for (const [id, range] of Object.entries(stepRanges)) {
    if (compare(range.start, position) > 0 || compare(position, range.end) > 0) continue;
    if (!found || compare(range.start, found.range.start) > 0 || compare(range.end, found.range.end) < 0) {
      found = { id, range };
    }
  }
  return found?.id;
}

/**
 * Hover for the `${{ … }}` template at `offset` of a workflow's YAML: its value in the run `context` (the
 * running run or the newest one), with `loop.*` read from the loop around the block the template is in.
 */
export function liveValueHover(
  text: string,
  offset: number,
  context: LiveContext,
  now: number,
): LiveValueHover | undefined {
  const match = templateAt(text, offset);
  if (!match) return undefined;
  const { workflow, stepRanges } = parseWorkflowText(text);
  const stepId = blockAt(stepRanges, positionAt(text, offset)) ?? null;
  const value = liveValue(context, match.expr, { workflow, stepId });
  return {
    markdown: [header(context, now), ...body(value)].join('\n\n'),
    start: match.start,
    end: match.end,
  };
}
