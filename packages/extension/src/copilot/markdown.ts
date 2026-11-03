const longestBacktickRun = (text: string) =>
  Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));

/** Inline code that stays inline code whatever backticks the text contains. */
export function inlineCode(text: string): string {
  const fence = '`'.repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A fenced code block whose fence is longer than any backtick run inside. */
export function codeBlock(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** Plain text (names, descriptions) on one line, with Markdown characters escaped. */
export function plainText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_{}[\]<>#|~]/g, '\\$&');
}
