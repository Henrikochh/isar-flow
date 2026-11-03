import type { Limits } from './facts';

const MARK = '… (shortened)';
const FACTORS = [0.5, 0.25, 0.1, 0];
/** File lists without a limit start at this many when the report has to get shorter. */
const OPEN_FILE_LIMIT = 100;

/**
 * Renders with the variant's limits; when the text is longer than `maxChars`, renders again with smaller limits
 * for answers, logs and file lists, and as a last resort cuts the text at a line boundary. Never longer than
 * `maxChars`.
 */
export function fitReport(
  render: (limits: Limits) => string,
  base: Limits,
  maxChars: number | undefined,
): string {
  const text = render(base);
  if (maxChars === undefined || text.length <= maxChars) return text;
  const max = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : text.length;
  let last = text;
  for (const factor of FACTORS) {
    last = render(scaled(base, factor));
    if (last.length <= max) return last;
  }
  return hardCut(last, max);
}

function scaled(base: Limits, factor: number): Limits {
  const files = Number.isFinite(base.files) ? base.files : OPEN_FILE_LIMIT;
  return {
    answerChars: Math.floor(base.answerChars * factor),
    logLines: Math.floor(base.logLines * factor),
    files: Math.floor(files * factor),
  };
}

/**
 * The text cut at a line boundary so that it fits `max` with a final "… (shortened)"; a code fence or a
 * `<details>` element left open by the cut is closed.
 */
export function hardCut(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < MARK.length + 2) return cutAt(text, max);
  let end = max - MARK.length - 2;
  for (;;) {
    const lineEnd = text.lastIndexOf('\n', end);
    const head = lineEnd <= 0 ? '' : text.slice(0, lineEnd).trimEnd();
    const result = head === '' ? MARK : `${head}${closers(head)}\n\n${MARK}`;
    if (result.length <= max) return result;
    end = lineEnd - 1;
  }
}

/** At most `max` UTF-16 units without splitting a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (max <= 0) return '';
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** What closes the code fence and `<details>` elements that `head` leaves open. */
function closers(head: string): string {
  let fence: string | undefined;
  let details = 0;
  for (const line of head.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && match[2].trim() === '') {
        fence = undefined;
      }
      continue;
    }
    if (match) fence = match[1];
    else details += (line.match(/<details>/g) ?? []).length - (line.match(/<\/details>/g) ?? []).length;
  }
  let result = fence !== undefined ? `\n${fence}` : '';
  for (let i = 0; i < details; i++) result += '\n\n</details>';
  return result;
}
