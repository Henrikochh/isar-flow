import {
  collapseWhitespace,
  dominantEol,
  endsWithEol,
  indentMap,
  isBlank,
  joinTextLines,
  reindent,
  splitTextLines,
  type TextLine,
  withFinalEol,
} from './lines';

/** How oldText was found: as written, after normalizing line endings, or line by line ignoring whitespace. */
export type MatchMode = 'exact' | 'lineEndings' | 'whitespace';

export type ReplaceResult =
  | { kind: 'replaced'; mode: MatchMode; content: string }
  | { kind: 'ambiguous'; mode: MatchMode; count: number }
  | { kind: 'notFound' };

/** Counting stops here; the exact number does not matter once it is clearly ambiguous. */
const MAX_COUNTED = 1000;

/**
 * Replaces the single occurrence of oldText in text, trying ever looser modes. Each mode must find exactly one
 * place: more stops with 'ambiguous', none falls through to the next mode.
 */
export function replaceOnce(text: string, oldText: string, newText: string): ReplaceResult {
  for (const attempt of [replaceExact, replaceNormalizedEol, replaceIgnoringWhitespace]) {
    const result = attempt(text, oldText, newText);
    if (result.kind !== 'notFound') return result;
  }
  return { kind: 'notFound' };
}

function replaceExact(text: string, oldText: string, newText: string): ReplaceResult {
  // readFile shows LF line ends, so the model sends LF; a CRLF file keeps its line ends. Places with either line
  // end count, so a file with mixed line ends can't hide a second place.
  const forms: [string, string][] = text.includes('\r\n')
    ? [
        [toCrlf(oldText), toCrlf(newText)],
        [toLf(oldText), toLf(newText)],
      ]
    : [[oldText, newText]];
  const found = forms
    .filter(([needle], i) => forms.findIndex(([other]) => other === needle) === i)
    .flatMap(([needle, replacement]) =>
      occurrences(text, needle).map((index) => ({ index, needle, replacement })),
    );
  if (found.length > 1) return { kind: 'ambiguous', mode: 'exact', count: found.length };
  if (found.length === 0) return { kind: 'notFound' };
  const [{ index, needle, replacement }] = found;
  return {
    kind: 'replaced',
    mode: 'exact',
    content: text.slice(0, index) + replacement + text.slice(index + needle.length),
  };
}

function replaceNormalizedEol(text: string, oldText: string, newText: string): ReplaceResult {
  if (!text.includes('\r') && !oldText.includes('\r')) return { kind: 'notFound' };
  const { normalized, offsets } = normalizeEol(text);
  const needle = oldText.replace(/\r\n?/g, '\n');
  const indexes = occurrences(normalized, needle);
  if (indexes.length > 1) return { kind: 'ambiguous', mode: 'lineEndings', count: indexes.length };
  if (indexes.length === 0) return { kind: 'notFound' };
  const [index] = indexes;
  const start = offsets[index];
  const end = offsets[index + needle.length];
  const eol = dominantEol(splitTextLines(text));
  const replacement = newText.replace(/\r\n?|\n/g, eol);
  return {
    kind: 'replaced',
    mode: 'lineEndings',
    content: text.slice(0, start) + replacement + text.slice(end),
  };
}

function replaceIgnoringWhitespace(text: string, oldText: string, newText: string): ReplaceResult {
  const { lines: wanted, leading, trailing } = trimBlankLines(splitTextLines(oldText).map((l) => l.text));
  if (wanted.length === 0) return { kind: 'notFound' };
  const lines = splitTextLines(text);
  const key = wanted.map(collapseWhitespace);
  const keys = lines.map((line) => collapseWhitespace(line.text));
  const starts: number[] = [];
  for (let i = 0; i + key.length <= keys.length && starts.length < MAX_COUNTED; i++) {
    if (key.every((k, j) => keys[i + j] === k)) starts.push(i);
  }
  if (starts.length > 1) return { kind: 'ambiguous', mode: 'whitespace', count: starts.length };
  if (starts.length === 0) return { kind: 'notFound' };

  const [start] = starts;
  const matched = lines.slice(start, start + wanted.length);
  const map = indentMap(wanted.map((line, j) => [line, matched[j].text] as const));
  const replacement = dropBlankLines(
    splitTextLines(newText).map((l) => l.text),
    leading,
    trailing,
  ).map((line) => reindent(line, map));
  const eol = dominantEol(lines);
  const lastEol = matched[matched.length - 1].eol;
  const inserted: TextLine[] = replacement.map((line, j) => ({
    text: line,
    eol: j === replacement.length - 1 ? lastEol : eol,
  }));
  const result = [...lines.slice(0, start), ...inserted, ...lines.slice(start + wanted.length)];
  return {
    kind: 'replaced',
    mode: 'whitespace',
    content: joinTextLines(withFinalEol(result, endsWithEol(lines), eol)),
  };
}

/** The lines without blank lines at the start and end, and how many were removed on each side. */
function trimBlankLines(lines: string[]): { lines: string[]; leading: number; trailing: number } {
  let first = 0;
  let last = lines.length;
  while (first < last && isBlank(lines[first])) first++;
  while (last > first && isBlank(lines[last - 1])) last--;
  return { lines: lines.slice(first, last), leading: first, trailing: lines.length - last };
}

/** Drops up to `leading` / `trailing` blank lines, the ones newText repeats from oldText's ignored ones. */
function dropBlankLines(lines: string[], leading: number, trailing: number): string[] {
  let first = 0;
  let last = lines.length;
  while (first < Math.min(leading, last) && isBlank(lines[first])) first++;
  while (last > first && lines.length - last < trailing && isBlank(lines[last - 1])) last--;
  return lines.slice(first, last);
}

/** Text with CRLF and CR turned into LF, and for each of its offsets the offset in the original text. */
function normalizeEol(text: string): { normalized: string; offsets: number[] } {
  let normalized = '';
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    offsets.push(i);
    if (text[i] === '\r') {
      normalized += '\n';
      if (text[i + 1] === '\n') i++;
    } else {
      normalized += text[i];
    }
  }
  offsets.push(text.length);
  return { normalized, offsets };
}

/** Start offsets of needle in text, overlapping ones included (they make a replacement ambiguous too). */
function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === '') return found;
  for (
    let i = text.indexOf(needle);
    i !== -1 && found.length < MAX_COUNTED;
    i = text.indexOf(needle, i + 1)
  ) {
    found.push(i);
  }
  return found;
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
