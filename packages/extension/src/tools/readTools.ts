import { splitLines } from '@isar-flow/core';
import { throwIfAborted } from './abort';
import { booleanArg, lineArg, requiredString, stringArg } from './args';
import { clip, isBinaryText, KB, plural, readWorkspaceText, truncateUtf8, workspaceGlob } from './text';
import { type ToolContext, ToolError, type ToolImpl } from './types';

const READ_LIMIT_BYTES = 200 * KB;
const LIST_MAX = 500;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILE_BYTES = 1024 * KB;
const SEARCH_MAX_FILES = 20_000;
const MATCH_LINE_MAX = 300;

export const readFile: ToolImpl = async (args, ctx) => {
  const input = requiredString(args, 'path');
  const startLine = lineArg(args, 'startLine');
  const endLine = lineArg(args, 'endLine');
  const absPath = await ctx.resolvePath(input);
  const rel = ctx.displayPath(absPath);
  const lines = splitLines(await readWorkspaceText(ctx, absPath, rel));
  if (lines.length === 0) return `${rel} (empty file)`;

  const start = startLine ?? 1;
  if (start > lines.length) {
    throw new ToolError(`${rel} has ${plural(lines.length, 'line')}; startLine ${start} is past the end.`);
  }
  const end = Math.min(endLine ?? lines.length, lines.length);
  if (end < start) throw new ToolError('endLine must not be smaller than startLine.');

  const picked: string[] = [];
  let bytes = 0;
  let note = '';
  for (let i = start - 1; i < end; i++) {
    const size = Buffer.byteLength(lines[i], 'utf8') + 1;
    if (bytes + size > READ_LIMIT_BYTES) {
      if (picked.length === 0) {
        picked.push(truncateUtf8(lines[i], READ_LIMIT_BYTES).text);
        note = `[Line ${i + 1} is longer than 200 KB and was cut.${i + 1 < end ? ` Continue with startLine ${i + 2}.` : ''}]`;
      } else {
        note = `[Truncated at 200 KB. Continue with startLine ${start + picked.length}.]`;
      }
      break;
    }
    picked.push(lines[i]);
    bytes += size;
  }
  const last = start + picked.length - 1;
  const header = `${rel} (lines ${start}-${last} of ${lines.length})`;
  return [header, ...picked, ...(note ? [note] : [])].join('\n');
};

export const listFiles: ToolImpl = async (args, ctx) => {
  const glob = workspaceGlob(stringArg(args, 'glob'));
  const found = sortPaths(await ctx.workspace.findFiles(glob, LIST_MAX + 1));
  if (found.length === 0) return `No files match ${glob}.`;
  const shown = found.slice(0, LIST_MAX);
  const more =
    found.length > LIST_MAX
      ? [`[Showing the first ${LIST_MAX} files. Use a narrower glob to see the rest.]`]
      : [];
  return [...shown, ...more].join('\n');
};

export const searchText: ToolImpl = async (args, ctx) => {
  const query = requiredString(args, 'query');
  if (query === '') throw new ToolError('"query" is empty. Pass the text to search for.');
  const glob = workspaceGlob(stringArg(args, 'glob'));
  const matches = lineMatcher(query, booleanArg(args, 'isRegex') ?? false);

  const files = sortPaths(await ctx.workspace.findFiles(glob, SEARCH_MAX_FILES));
  const results: string[] = [];
  for (const rel of files) {
    throwIfAborted(ctx.io.signal);
    const text = await readForSearch(ctx, rel);
    if (text === undefined) continue;
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
      if (!matches(lines[i])) continue;
      if (results.length === SEARCH_MAX_MATCHES) {
        results.push(
          `[Stopped after ${SEARCH_MAX_MATCHES} matches. Use a more specific query or a glob to narrow the search.]`,
        );
        return results.join('\n');
      }
      results.push(`${rel}:${i + 1}: ${clip(lines[i].trim(), MATCH_LINE_MAX)}`);
    }
  }
  if (results.length === 0) {
    return `No matches for ${JSON.stringify(query)}${glob === '**/*' ? '' : ` in ${glob}`}.`;
  }
  if (files.length >= SEARCH_MAX_FILES) {
    results.push(`[Searched the first ${SEARCH_MAX_FILES} files only. Use a glob to narrow the search.]`);
  }
  return results.join('\n');
};

function lineMatcher(query: string, isRegex: boolean): (line: string) => boolean {
  if (!isRegex) return (line) => line.includes(query);
  let regex: RegExp;
  try {
    regex = new RegExp(query);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message = reason.includes('Invalid regular expression')
      ? reason
      : `Invalid regular expression: ${reason}`;
    throw new ToolError(`${message}. Fix the pattern, or search for plain text with isRegex false.`);
  }
  return (line) => regex.test(line);
}

/** The file's text, or undefined when it should be skipped (outside, unreadable, too large, binary). */
async function readForSearch(ctx: ToolContext, rel: string): Promise<string | undefined> {
  try {
    const absPath = await ctx.resolvePath(rel);
    const size = await ctx.workspace.fileSize?.(absPath);
    if (size !== undefined && size > SEARCH_MAX_FILE_BYTES) return undefined;
    const text = await ctx.workspace.readFile(absPath);
    if (text.length > SEARCH_MAX_FILE_BYTES || isBinaryText(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function sortPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
