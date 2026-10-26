import type { TextEdit } from './types';

/** True when `offset` falls between the halves of a surrogate pair or of a CRLF line break. */
function splitsUnit(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  if (before === 13 && after === 10) return true;
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * The smallest single replacement that turns `oldText` into `newText`, so editors only touch the changed
 * range (keeping cursor, folding and undo granularity intact).
 */
export function minimalTextEdit(oldText: string, newText: string): TextEdit {
  const max = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  if (splitsUnit(oldText, start)) start--;

  let suffix = 0;
  const maxSuffix = max - start;
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && splitsUnit(oldText, oldText.length - suffix)) suffix--;

  return { start, end: oldText.length - suffix, text: newText.slice(start, newText.length - suffix) };
}
