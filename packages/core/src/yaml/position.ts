import type { Position, Range } from '../diagnostics';

export type PositionMapper = (offset: number) => Position;

/** Builds a fast offset → position lookup. `\r\n`, `\n` and a lone `\r` each end a line, as in VS Code. */
export function createPositionMapper(text: string): PositionMapper {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      lineStarts.push(i + 1);
    } else if (c === 10) {
      lineStarts.push(i + 1);
    }
  }
  return (offset) => {
    const o = Math.max(0, Math.min(offset, text.length));
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: o - lineStarts[lo] };
  };
}

/** Converts a UTF-16 offset into a 0-based line/character position. */
export function offsetToPosition(text: string, offset: number): Position {
  return createPositionMapper(text)(offset);
}

export function offsetsToRange(map: PositionMapper, start: number, end: number): Range {
  return { start: map(start), end: map(Math.max(start, end)) };
}
