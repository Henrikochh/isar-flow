import {
  collapseWhitespace,
  dominantEol,
  endsWithEol,
  indentMap,
  joinTextLines,
  reindent,
  splitTextLines,
  type TextLine,
  withFinalEol,
} from './lines';
import { clip, plural } from './text';
import type { FilePatch, PatchHunk } from './unifiedDiff';

/** How far from the stated line a hunk is searched before the whole file is tried. */
const SEARCH_WINDOW = 200;
const QUOTE_MAX = 120;

/** New content of one file (null = delete it), or why its hunks do not apply. */
export type FilePlan =
  | { ok: true; content: string | null; added: number; removed: number; notes: string[] }
  | { ok: false; failures: string[] };

const trimEnd = (line: string) => line.replace(/\s+$/, '');
const quote = (line: string) => `"${clip(line.trim(), QUOTE_MAX)}"`;

/**
 * Applies the hunks of one file to its current text (undefined when it does not exist). Pure: the caller reads
 * and writes. Hunks apply in order without overlapping; the file keeps its line endings and final newline.
 */
export function planFile(file: FilePatch, path: string, current: string | undefined): FilePlan {
  if (file.oldPath === null) return planCreate(file, path, current);
  if (current === undefined) {
    if (file.newPath === null) return failed(`${path} does not exist, so the patch cannot delete it.`);
    return failed(
      `${path} does not exist. To create it, start its section with "--- /dev/null" and "+++ b/${path}".`,
    );
  }
  if (file.newPath === null) return planDelete(file, path, current);
  return planModify(file, path, current);
}

function failed(...failures: string[]): FilePlan {
  return { ok: false, failures };
}

function planCreate(file: FilePatch, path: string, current: string | undefined): FilePlan {
  if (current !== undefined) {
    return failed(
      `${path} already exists, so the patch cannot create it. Read it and make a patch that changes it.`,
    );
  }
  const added = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
  const finalNewline = added.length > 0 && !file.hunks[file.hunks.length - 1].noNewlineAtEnd;
  const content = added.join('\n') + (finalNewline ? '\n' : '');
  return { ok: true, content, added: added.length, removed: 0, notes: [] };
}

function planDelete(file: FilePatch, path: string, current: string): FilePlan {
  const expected = withoutTrailingBlanks(file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)));
  const actual = withoutTrailingBlanks(splitTextLines(current).map((line) => line.text));
  const differs = Array.from({ length: Math.max(expected.length, actual.length) }, (_, j) => j).find(
    (j) =>
      j >= expected.length ||
      j >= actual.length ||
      collapseWhitespace(expected[j]) !== collapseWhitespace(actual[j]),
  );
  if (differs !== undefined) {
    const where =
      differs < actual.length
        ? `line ${differs + 1} of the file: ${quote(actual[differs])}`
        : `the file has only ${plural(actual.length, 'line')}`;
    return failed(`${path} does not match the lines the patch removes, so it was not deleted (${where}).`);
  }
  const removed = file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind === '-').length, 0);
  return { ok: true, content: null, added: 0, removed, notes: [] };
}

function withoutTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

interface Edit {
  start: number;
  count: number;
  lines: TextLine[];
}

type Located =
  { kind: 'found'; at: number; loose: boolean } | { kind: 'ambiguous'; count: number } | { kind: 'none' };

/** Compares file lines with hunk lines: first ignoring trailing whitespace, then all whitespace differences. */
class FileText {
  readonly texts: string[];
  private readonly levels: string[][];

  constructor(readonly lines: TextLine[]) {
    this.texts = lines.map((line) => line.text);
    this.levels = [this.texts.map(trimEnd), this.texts.map(collapseWhitespace)];
  }

  locate(expected: string[], stated: number | undefined, floor: number): Located {
    for (const [level, normalize] of [trimEnd, collapseWhitespace].entries()) {
      const key = expected.map(normalize);
      const file = this.levels[level];
      const fits = (p: number) =>
        p >= floor && p + key.length <= file.length && key.every((k, j) => file[p + j] === k);
      const loose = level === 1;
      if (stated !== undefined) {
        for (let distance = 0; distance <= SEARCH_WINDOW; distance++) {
          if (fits(stated - distance)) return { kind: 'found', at: stated - distance, loose };
          if (distance > 0 && fits(stated + distance)) return { kind: 'found', at: stated + distance, loose };
        }
      }
      const matches: number[] = [];
      for (let p = floor; p + key.length <= file.length && matches.length < 2; p++)
        if (fits(p)) matches.push(p);
      if (matches.length === 1) return { kind: 'found', at: matches[0], loose };
      if (matches.length > 1) return { kind: 'ambiguous', count: this.count(key, level, floor) };
    }
    return { kind: 'none' };
  }

  private count(key: string[], level: number, floor: number): number {
    const file = this.levels[level];
    let count = 0;
    for (let p = floor; p + key.length <= file.length; p++)
      if (key.every((k, j) => file[p + j] === k)) count++;
    return count;
  }

  /** Why the context is not at the stated line (or anywhere, without one), for the model to fix its patch. */
  explainMissing(expected: string[], stated: number | undefined): string {
    if (stated === undefined) {
      const known = new Set(this.levels[1]);
      const missing = expected.find((line) => !known.has(collapseWhitespace(line)));
      return missing === undefined
        ? 'the context was not found; its lines are in the file, but not in this order.'
        : `the context was not found; ${quote(missing)} is not in the file.`;
    }
    const start = Math.min(Math.max(stated, 0), this.texts.length);
    const j = expected.findIndex(
      (line, k) => start + k >= this.texts.length || collapseWhitespace(line) !== this.levels[1][start + k],
    );
    const index = start + Math.max(j, 0);
    const where =
      index < this.texts.length
        ? `line ${index + 1} of the file: ${quote(this.texts[index])}`
        : `the file has only ${plural(this.texts.length, 'line')}`;
    return `the context was not found near line ${start + 1}; first differing line: ${quote(expected[Math.max(j, 0)])} (${where}).`;
  }
}

/** 0-based index of the hunk's first old line; a hunk without old lines inserts after line oldStart. */
function statedIndex(hunk: PatchHunk, expected: string[]): number | undefined {
  if (hunk.oldStart === undefined) return undefined;
  return expected.length === 0 ? hunk.oldStart : Math.max(hunk.oldStart - 1, 0);
}

function planModify(file: FilePatch, path: string, current: string): FilePlan {
  const text = new FileText(splitTextLines(current));
  const eol = dominantEol(text.lines);
  const edits: Edit[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  let drift = 0;
  let floor = 0;
  let added = 0;
  let removed = 0;

  file.hunks.forEach((hunk, index) => {
    const name = `${path} hunk ${index + 1}`;
    const expected = hunk.lines.filter((line) => line.kind !== '+').map((line) => line.text);
    const base = statedIndex(hunk, expected);
    const stated = base === undefined ? undefined : base + drift;
    const located = locateHunk(text, expected, stated, floor);
    if (located.kind !== 'found') {
      failures.push(`${name} (${hunk.header}): ${describeFailure(text, expected, stated, floor, located)}`);
      return;
    }
    const { at, loose } = located;
    if (base !== undefined) {
      if (at !== stated) notes.push(`${name} matched at line ${at + 1} instead of line ${base + 1}.`);
      drift = at - base;
    }
    if (loose) notes.push(`${name} matched ignoring whitespace; the indentation was taken from the file.`);
    const map = loose ? indentMap(expected.map((line, j) => [line, text.texts[at + j]] as const)) : undefined;
    const lines: TextLine[] = [];
    let k = at;
    for (const line of hunk.lines) {
      if (line.kind === ' ') lines.push(text.lines[k++]);
      else if (line.kind === '-') k++;
      else lines.push({ text: map ? reindent(line.text, map) : line.text, eol });
    }
    added += hunk.lines.filter((line) => line.kind === '+').length;
    removed += hunk.lines.filter((line) => line.kind === '-').length;
    edits.push({ start: at, count: expected.length, lines });
    floor = at + expected.length;
  });
  if (failures.length > 0) return { ok: false, failures };

  const result: TextLine[] = [];
  let cursor = 0;
  for (const edit of edits) {
    result.push(...text.lines.slice(cursor, edit.start), ...edit.lines);
    cursor = edit.start + edit.count;
  }
  result.push(...text.lines.slice(cursor));
  // A line that used to be last may now be followed by others and needs a line break.
  const joined = result.map((line, i) =>
    line.eol === '' && i < result.length - 1 ? { ...line, eol } : line,
  );
  const content = joinTextLines(withFinalEol(joined, endsWithEol(text.lines), eol));
  return { ok: true, content, added, removed, notes };
}

function locateHunk(text: FileText, expected: string[], stated: number | undefined, floor: number): Located {
  if (expected.length > 0) return text.locate(expected, stated, floor);
  if (stated !== undefined)
    return { kind: 'found', at: Math.min(Math.max(stated, floor), text.lines.length), loose: false };
  return text.lines.length === 0 ? { kind: 'found', at: 0, loose: false } : { kind: 'none' };
}

function describeFailure(
  text: FileText,
  expected: string[],
  stated: number | undefined,
  floor: number,
  located: Located,
): string {
  if (located.kind === 'ambiguous') {
    return `the context matches ${located.count} places. Add more context lines so it matches once.`;
  }
  if (expected.length === 0) {
    return (
      'the hunk has no context lines and no line number, so its place is unknown. ' +
      'Add a few unchanged lines around the change.'
    );
  }
  if (floor > 0 && text.locate(expected, stated, 0).kind === 'found') {
    return 'it overlaps an earlier hunk or comes before it. Hunks must be in file order and must not overlap.';
  }
  return text.explainMissing(expected, stated);
}
