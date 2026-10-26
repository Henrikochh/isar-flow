import type { Range } from '@isar-flow/core';

type Path = readonly (string | number)[];

const BLOCK_SLOTS = new Set(['steps', 'then', 'else']);

/** Splits like VS Code: `\r\n`, `\n` and a lone `\r` each end a line. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Length of the path prefix that addresses the innermost block (`…, steps|then|else, <index>`). */
function blockPathLength(path: Path): number {
  for (let i = path.length - 1; i >= 1; i--) {
    const slot = path[i - 1];
    if (typeof path[i] === 'number' && typeof slot === 'string' && BLOCK_SLOTS.has(slot)) return i + 1;
  }
  return 0;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineEnd = (line: string) => line.replace(/\s+$/, '').length;

interface Hit {
  line: number;
  column: number;
}

/** A mapping key at exactly `column`, with only indentation (or the block's own `- `) before it. */
function findKeyAtColumn(
  lines: string[],
  key: string,
  column: number,
  from: number,
  to: number,
): Hit | undefined {
  const pattern = new RegExp(`^${escapeRegex(key)}\\s*:(?=\\s|$)`);
  for (let line = from; line <= to && line < lines.length; line++) {
    const text = lines[line];
    const before = text.slice(0, column);
    if (line !== from && before.trim() !== '') continue;
    if (pattern.test(text.slice(column))) return { line, column };
  }
  return undefined;
}

/** The next mapping key in block or flow style (`key:`, `- key:`, `{ key:`, `, key:`) after `after`. */
function findNestedKey(lines: string[], key: string, after: Hit, to: number): Hit | undefined {
  const pattern = new RegExp(`(?<=^|[\\s{,])${escapeRegex(key)}\\s*:(?=\\s|$)`, 'g');
  for (let line = after.line; line <= to && line < lines.length; line++) {
    pattern.lastIndex = line === after.line ? after.column + 1 : 0;
    const match = pattern.exec(lines[line]);
    if (match) return { line, column: match.index };
  }
  return undefined;
}

/**
 * Best-effort range for a diagnostic that only has a YAML path: the line of the deepest key that can be found,
 * from the key to the end of its line. `block` is the range of the block the path belongs to; without it the
 * path starts at the document root. List indices inside a block end the search. Falls back to the first line of
 * the block, or undefined when nothing matches outside a block.
 */
export function locateDiagnosticRange(lines: string[], path: Path, block?: Range): Range | undefined {
  const keys = block ? path.slice(blockPathLength(path)) : path;
  const to = block ? block.end.line : lines.length - 1;
  let hit: Hit | undefined;
  for (const key of keys) {
    if (typeof key === 'number') break;
    const next = hit
      ? findNestedKey(lines, key, hit, to)
      : findKeyAtColumn(lines, key, block ? block.start.character : 0, block ? block.start.line : 0, to);
    if (!next) break;
    hit = next;
  }
  if (hit) {
    const end = Math.max(hit.column, lineEnd(lines[hit.line]));
    return { start: { line: hit.line, character: hit.column }, end: { line: hit.line, character: end } };
  }
  if (!block) return undefined;
  if (block.start.line === block.end.line) return block;
  const end = Math.max(block.start.character, lineEnd(lines[block.start.line] ?? ''));
  return { start: block.start, end: { line: block.start.line, character: end } };
}
