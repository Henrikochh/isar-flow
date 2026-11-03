/** Largest `git.diff` in UTF-8 bytes, the final note included. */
export const GIT_DIFF_MAX_BYTES = 102400;
/** Most paths in `git.changedFiles`. */
export const GIT_CHANGED_FILES_MAX = 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** "100 KB", "1.5 KB", "200 bytes". */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
}

/**
 * The diff when it fits into `maxBytes` (UTF-8); otherwise its beginning, cut at a line boundary, and a final line
 * "… The diff was shortened to 100 KB (<total>)." The result fits into `maxBytes` (unless the note alone does not).
 * `total` is git's `--shortstat` line for the whole diff.
 */
export function capDiff(diff: string, maxBytes: number, total?: string): string {
  const encoded = encoder.encode(diff);
  if (encoded.length <= maxBytes) return diff;

  const detail = total?.trim() ? ` (${total.trim()})` : '';
  const note = `… The diff was shortened to ${formatByteSize(maxBytes)}${detail}.`;
  const room = maxBytes - encoder.encode(note).length - 1;
  if (room <= 0) return note;

  let end = room;
  // A continuation byte (10xxxxxx) at the cut means the character before it would be split.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  const head = decoder.decode(encoded.subarray(0, end));
  const lineEnd = head.lastIndexOf('\n');
  const kept = (lineEnd === -1 ? head : head.slice(0, lineEnd)).replace(/\r$/, '');
  return kept === '' ? note : `${kept}\n${note}`;
}
