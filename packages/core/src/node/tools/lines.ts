/** One line of a text with the line break that ends it ('' for a last line without one). */
export interface TextLine {
  text: string;
  eol: string;
}

const LINE_BREAK = /\r\n|\n|\r/g;

export function splitTextLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (const match of text.matchAll(LINE_BREAK)) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' });
  return lines;
}

export function joinTextLines(lines: readonly TextLine[]): string {
  return lines.map((line) => line.text + line.eol).join('');
}

/** The most common line break of the lines; LF when there is none. */
export function dominantEol(lines: readonly TextLine[]): string {
  const counts = new Map<string, number>();
  for (const { eol } of lines) if (eol !== '') counts.set(eol, (counts.get(eol) ?? 0) + 1);
  let best = '\n';
  let bestCount = 0;
  for (const [eol, count] of counts) {
    if (count > bestCount) [best, bestCount] = [eol, count];
  }
  return best;
}

/** Whether the text ends with a line break; an empty text counts as ending with one. */
export function endsWithEol(lines: readonly TextLine[]): boolean {
  return lines.length === 0 || lines[lines.length - 1].eol !== '';
}

/** Gives the last line a line break (`eol`) or removes it, so a file keeps its final-newline state. */
export function withFinalEol(lines: TextLine[], wanted: boolean, eol: string): TextLine[] {
  const last = lines[lines.length - 1];
  if (!last || (last.eol !== '') === wanted) return lines;
  return [...lines.slice(0, -1), { text: last.text, eol: wanted ? eol : '' }];
}

export const isBlank = (line: string): boolean => line.trim() === '';

/** A line with leading and trailing whitespace removed and inner whitespace runs collapsed to one space. */
export function collapseWhitespace(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function indentation(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? '';
}

/**
 * Maps the indentation of lines the model wrote to the indentation of the file lines they matched (the first
 * pair wins). Blank lines say nothing about indentation and are skipped.
 */
export function indentMap(pairs: readonly (readonly [model: string, file: string])[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const [model, file] of pairs) {
    if (isBlank(model) || isBlank(file)) continue;
    const from = indentation(model);
    if (!map.has(from)) map.set(from, indentation(file));
  }
  return map;
}

/**
 * Re-indents a line the model wrote: the longest known indentation it starts with is replaced by the file's,
 * so relative indentation stays and the file's tabs or spaces are used. Other lines stay as they are.
 */
export function reindent(line: string, map: ReadonlyMap<string, string>): string {
  if (isBlank(line)) return line;
  const own = indentation(line);
  let best: string | undefined;
  for (const from of map.keys()) {
    if (own.startsWith(from) && (best === undefined || from.length > best.length)) best = from;
  }
  return best === undefined ? line : (map.get(best) ?? '') + line.slice(best.length);
}
