import type { ToolSpec } from '../models/types';
import { formatNumber } from './format';
import type { AgentMemory } from './types';

/** The project memory file, relative to the workspace folder. */
export const MEMORY_FILE = '.isarflow/memory.md';
/** Agents see at most this many UTF-8 bytes of the memory file in their system prompt. */
export const MEMORY_PROMPT_MAX_BYTES = 8192;
/** remember refuses to write to a memory file larger than this (enforced by the hosts). */
export const MEMORY_FILE_MAX_BYTES = 65536;
export const MEMORY_NOTE_MAX_CHARS = 500;

/** Not a ToolName: the agent loop answers remember calls itself (AgentMemory.remember). */
export const REMEMBER_TOOL: ToolSpec = {
  name: 'remember',
  description:
    'Save one short, durable fact about this project (conventions, commands, decisions) to the project memory ' +
    'so later runs know it. Not for task progress. At most 500 characters.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'The fact to remember, e.g. "Tests run with npm test -w core."' },
    },
    required: ['note'],
    additionalProperties: false,
  },
};

const HEADER =
  '# Project memory\n\nNotes for Isar Flow agents. Agents with memory set to read see the first 8 KB of this ' +
  'file; agents with write add notes with the remember tool. Edit it freely.\n\n';

export const MEMORY_NOT_TEXT =
  `${MEMORY_FILE} isn't UTF-8 text, so it isn't used. ` +
  'Save it with the encoding UTF-8 (Save with Encoding in VS Code).';

/**
 * The text of the memory file's bytes: UTF-8, a byte order mark dropped, line endings kept. Throws MEMORY_NOT_TEXT
 * for other encodings (UTF-16, Latin-1 …): read as UTF-8 they turn into replacement characters, and remember would
 * write those back over the user's notes.
 */
export function decodeMemoryText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(MEMORY_NOT_TEXT);
  }
  // UTF-16 text of ASCII characters is valid UTF-8, but full of NUL characters.
  if (text.includes('\0')) throw new Error(MEMORY_NOT_TEXT);
  return text;
}

/** Text of a new memory file: a heading and a short explanation. */
export function newMemoryText(): string {
  return HEADER;
}

function normalizeNote(note: string): string {
  return note.replace(/\s+/g, ' ').trim();
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `- 2026-11-03: <note>` with the local date; whitespace runs become one space. */
export function memoryNoteLine(note: string, date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `- ${day}: ${normalizeNote(note)}`;
}

/** Why a note can't be saved (empty, too long, contains a secret value), or undefined. */
export function checkMemoryNote(note: string, secrets: readonly string[]): string | undefined {
  const normalized = normalizeNote(note);
  if (normalized === '') return 'The note is empty. Write one short fact to remember.';
  const leaks = secrets.some(
    (secret) => secret.length >= 4 && (note.includes(secret) || normalized.includes(normalizeNote(secret))),
  );
  if (leaks) return "The note contains a secret value, so it wasn't saved.";
  const length = [...normalized].length;
  if (length > MEMORY_NOTE_MAX_CHARS) {
    return `The note is too long (${formatNumber(length)} characters). Keep it under ${MEMORY_NOTE_MAX_CHARS} characters.`;
  }
  return undefined;
}

/**
 * The memory text an agent sees: line endings normalized, then cut to the first 8 KB (UTF-8) at a line boundary,
 * or at a character boundary when the last line break is far back.
 */
export function capMemoryText(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const encoded = new TextEncoder().encode(normalized);
  if (encoded.length <= MEMORY_PROMPT_MAX_BYTES) return { text: normalized, truncated: false };

  let end = MEMORY_PROMPT_MAX_BYTES;
  // A continuation byte (10xxxxxx) at the cut means the character before it would be split.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  const cut = new TextDecoder().decode(encoded.subarray(0, end));
  const lineEnd = cut.lastIndexOf('\n');
  const atLine = lineEnd > 0 && lineEnd >= cut.length / 2;
  return { text: atLine ? cut.slice(0, lineEnd) : cut, truncated: true };
}

/** The file text with `line` appended; a missing file starts with the header. Keeps CRLF files CRLF. */
export function appendMemoryNote(existing: string | undefined, line: string): string {
  if (existing === undefined) return `${HEADER}${line}\n`;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  if (existing === '') return `${line}${eol}`;
  const base = existing.endsWith('\n') ? existing : `${existing}${eol}`;
  return `${base}${line}${eol}`;
}

const REMEMBER_HINT =
  'Use the remember tool to save a short, durable fact about this project for later runs, one per call.';

/** The "Project memory" section of the system prompt; empty without notes and without remember. */
export function memorySection(memory: AgentMemory | undefined): string {
  const text = memory?.text?.trimEnd() ?? '';
  const hasText = text.trim() !== '';
  if (!hasText && !memory?.remember) return '';
  const parts = ['## Project memory'];
  if (hasText) {
    parts.push(
      'Notes saved in .isarflow/memory.md by earlier runs. Use them as background; the task has priority.',
      text,
    );
    if (memory?.truncated) parts.push('(Only the beginning of the file is shown.)');
  } else {
    parts.push('No notes are saved in .isarflow/memory.md yet.');
  }
  if (memory?.remember) parts.push(REMEMBER_HINT);
  return parts.join('\n\n');
}

/** The agent's system prompt followed by the memory section (or only the section). */
export function withMemorySection(
  systemPrompt: string | undefined,
  memory: AgentMemory | undefined,
): string | undefined {
  const section = memorySection(memory);
  if (section === '') return systemPrompt;
  const prompt = systemPrompt?.trimEnd() ?? '';
  return prompt.trim() === '' ? section : `${prompt}\n\n${section}`;
}
