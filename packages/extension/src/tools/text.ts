import fs from 'node:fs';
import { splitLines } from '@isar-flow/core';
import { ToolError, type ToolContext } from './types';

export const KB = 1024;
/** Files above this size are not read at all (protects the extension host's memory). */
const MAX_READABLE_BYTES = 20 * KB * KB;

/** Text decoded from a binary file contains NUL characters; real text files practically never do. */
export function isBinaryText(text: string): boolean {
  return text.includes('\u0000');
}

export function lineCount(text: string): number {
  return splitLines(text).length;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Shortens text to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** First line of a text, shortened, for one-line summaries. */
export function firstLine(text: string, max: number): string {
  const lines = splitLines(text.trim());
  const first = lines[0] ?? '';
  return clip(lines.length > 1 ? `${first} …` : first, max);
}

/** Cuts text to at most `maxBytes` UTF-8 bytes, preferably after a line break. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  const lineEnd = cut.lastIndexOf('\n');
  if (lineEnd > cut.length / 2) cut = cut.slice(0, lineEnd + 1);
  return { text: cut, truncated: true };
}

/** The last `maxChars` characters, with a note about what was left out. */
export function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `… ${omitted} earlier characters omitted …\n${text.slice(-maxChars)}`;
}

/** Reads a workspace file as text with errors the model can act on. */
export async function readWorkspaceText(ctx: ToolContext, absPath: string, rel: string): Promise<string> {
  if (!(await ctx.workspace.exists(absPath))) {
    throw new ToolError(`File not found: ${rel}. Use listFiles to see which files exist.`);
  }
  const size = await ctx.workspace.fileSize?.(absPath);
  if (size !== undefined && size > MAX_READABLE_BYTES) {
    throw new ToolError(`${rel} is too large to read (${Math.round(size / KB / KB)} MB).`);
  }
  let text: string;
  try {
    text = await ctx.workspace.readFile(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') {
      throw new ToolError(`${rel} is a folder, not a file. Use listFiles to see its files.`);
    }
    throw new ToolError(`Could not read ${rel}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isBinaryText(text)) throw new ToolError(`${rel} looks like a binary file and cannot be read as text.`);
  return text;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Whether the file's bytes are valid UTF-8; true when it can't be read (the write reports that). */
async function isUtf8File(absPath: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(absPath);
  } catch {
    return true;
  }
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The text of a file an edit tool changes. A file that is not UTF-8 on disk reads with replacement characters
 * (U+FFFD); writing them back would destroy the characters they stand for, so such a file is refused.
 */
export async function readEditableText(ctx: ToolContext, absPath: string, rel: string): Promise<string> {
  const text = await readWorkspaceText(ctx, absPath, rel);
  if (text.includes('�') && !(await isUtf8File(absPath))) {
    throw new ToolError(
      `${rel} is not UTF-8 text, so it was not changed: characters that can't be read (shown as "�") ` +
        'would be lost. Leave it as it is, or ask the user to convert it to UTF-8.',
    );
  }
  return text;
}

/** Workspace-relative glob with forward slashes; refuses absolute globs and `..`. */
export function workspaceGlob(glob: string | undefined): string {
  let result = (glob ?? '').trim().replace(/\\/g, '/');
  while (result.startsWith('./')) result = result.slice(2);
  if (result === '') return '**/*';
  if (result.startsWith('/') || /^[a-z]:/i.test(result) || result.split('/').includes('..')) {
    throw new ToolError(
      `The glob "${glob}" must be relative to the workspace root without "..", for example "src/**/*.ts".`,
    );
  }
  return result;
}
