import { isBinary } from './util';

/** Above these sizes the counts are estimated (every differing line counts) instead of diffed. */
const MAX_DIFF_LINES = 20_000;
const MAX_EDIT_DISTANCE = 2_000;

function linesOf(bytes: Uint8Array | null): string[] {
  if (bytes === null || bytes.length === 0) return [];
  const lines = Buffer.from(bytes).toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Myers' shortest edit script length (insertions + deletions), or undefined above `max`. */
function editDistance(a: string[], b: string[], max: number): number | undefined {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  for (let d = 0; d <= Math.min(max, n + m); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return undefined;
}

/**
 * Added and removed lines between two versions of a file (null = the file did not exist), like git's numstat;
 * `binary` when either side looks binary.
 */
export function lineStats(
  before: Uint8Array | null,
  after: Uint8Array | null,
): { additions: number; deletions: number } | { binary: true } {
  if ((before && isBinary(before)) || (after && isBinary(after))) return { binary: true };
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const oldLines = a.slice(start, endA);
  const newLines = b.slice(start, endB);
  const distance =
    oldLines.length + newLines.length <= MAX_DIFF_LINES
      ? editDistance(oldLines, newLines, MAX_EDIT_DISTANCE)
      : undefined;
  if (distance === undefined) return { additions: newLines.length, deletions: oldLines.length };
  const common = (oldLines.length + newLines.length - distance) / 2;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}
