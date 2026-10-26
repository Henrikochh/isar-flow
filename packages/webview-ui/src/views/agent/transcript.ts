/**
 * The Try it conversation: entry shape (persisted in the webview state) and the pure reducers that turn
 * host `tryItEvent`s into transcript rows.
 */
import { describeToolCall, summarizeToolResult, type TryItEvent, type Usage } from '@isar-flow/core';
import { formatTokens } from '../../hooks';

export interface TranscriptEntry {
  role: 'user' | 'agent' | 'tool' | 'error';
  text: string;
  /** Tool name for tool rows; failed tool calls are 'error' rows that keep their tool name. */
  tool?: string;
  /** Secondary line: "<model> · <n> tokens" under an answer, the result summary of a tool row. */
  meta?: string;
}

/** Shape stored with `setViewState`. */
export interface TryItViewState {
  tryIt?: { messages?: TranscriptEntry[] };
}

export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

const META_SEPARATOR = ' · ';
export const STOPPED_META = 'Stopped';

export function answerMeta(model: string, usage: Usage): string {
  const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  return [model, `${formatTokens(total)} tokens`].filter(Boolean).join(META_SEPARATOR);
}

/** Splits a meta string into the parts rendered as separate spans. */
export function metaParts(meta: string): string[] {
  return meta
    .split(META_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

const ROLES = new Set(['user', 'agent', 'tool', 'error']);

function isEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.role === 'string' &&
    ROLES.has(entry.role) &&
    typeof entry.text === 'string' &&
    (entry.tool === undefined || typeof entry.tool === 'string') &&
    (entry.meta === undefined || typeof entry.meta === 'string')
  );
}

/** Reads the persisted transcript, dropping anything that does not look like an entry. */
export function readTranscript(state: unknown): TranscriptEntry[] {
  const messages = (state as TryItViewState | undefined)?.tryIt?.messages;
  return Array.isArray(messages) ? messages.filter(isEntry) : [];
}

function isOpenAnswer(entry: TranscriptEntry | undefined): entry is TranscriptEntry {
  return entry?.role === 'agent' && entry.meta === undefined;
}

function parseArgs(args: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(args);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** One-line detail of a tool call without the tool name, e.g. `src/app.ts:10-40`. */
export function toolCallDetail(name: string, args: string): string {
  const parsed = parseArgs(args);
  if (!parsed) return args.trim() === '{}' ? '' : args.replace(/\s+/g, ' ').trim();
  const line = describeToolCall(name, parsed);
  return line.startsWith(name) ? line.slice(name.length).trim() : line;
}

/** Closes the current answer with a meta line, or adds a meta-only answer when the turn has no open text. */
function closeTurn(entries: TranscriptEntry[], meta: string): TranscriptEntry[] {
  const last = entries[entries.length - 1];
  if (isOpenAnswer(last)) return [...entries.slice(0, -1), { ...last, meta }];
  return [...entries, { role: 'agent', text: '', meta }];
}

export function applyTryItEvent(entries: TranscriptEntry[], event: TryItEvent): TranscriptEntry[] {
  const last = entries[entries.length - 1];
  switch (event.type) {
    case 'text':
      if (isOpenAnswer(last)) return [...entries.slice(0, -1), { ...last, text: last.text + event.text }];
      return [...entries, { role: 'agent', text: event.text }];
    case 'tool': {
      const text = toolCallDetail(event.name, event.args);
      const meta =
        event.result === undefined ? undefined : summarizeToolResult({ content: event.result, isError: event.isError });
      const row: TranscriptEntry = { role: event.isError ? 'error' : 'tool', tool: event.name, text, meta };
      // A finished call completes the pending row the host announced for it.
      const pending = last?.role === 'tool' && last.tool === event.name && last.text === text && last.meta === undefined;
      return pending ? [...entries.slice(0, -1), row] : [...entries, row];
    }
    case 'done':
      return closeTurn(entries, answerMeta(event.model, event.usage));
    case 'error':
      return [...entries, { role: 'error', text: event.message }];
  }
}

export function stopTurn(entries: TranscriptEntry[]): TranscriptEntry[] {
  return closeTurn(entries, STOPPED_META);
}

/** Prior conversation for the `tryIt` message: user prompts and answers, tool rows left out. */
export function conversationHistory(entries: TranscriptEntry[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const entry of entries) {
    if (entry.role === 'user') history.push({ role: 'user', content: entry.text });
    else if (entry.role === 'agent' && entry.text.trim()) {
      const previous = history[history.length - 1];
      if (previous?.role === 'assistant') previous.content += `\n\n${entry.text}`;
      else history.push({ role: 'assistant', content: entry.text });
    }
  }
  return history;
}

export interface Turn {
  /** Index of the first entry, used as a stable React key. */
  start: number;
  kind: 'user' | 'agent';
  entries: TranscriptEntry[];
}

/** Groups the transcript into user messages and agent turns (everything between two user messages). */
export function groupTurns(entries: TranscriptEntry[]): Turn[] {
  const turns: Turn[] = [];
  entries.forEach((entry, index) => {
    const current = turns[turns.length - 1];
    if (entry.role === 'user') turns.push({ start: index, kind: 'user', entries: [entry] });
    else if (current?.kind === 'agent') current.entries.push(entry);
    else turns.push({ start: index, kind: 'agent', entries: [entry] });
  });
  return turns;
}
