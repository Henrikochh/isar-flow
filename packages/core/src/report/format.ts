/** `12,345`: rounded to a whole number, with thousands separators. */
export function formatNumber(value: number): string {
  const rounded = String(Math.round(value));
  return rounded.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "450ms", "12.3s", "4m 12s", "1h 5m". */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 59_950) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const seconds = Math.round(value / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** "2026-11-03 14:02 UTC". */
export function formatUtcTime(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** An estimated cost without a currency (prices are in the unit the user wrote them); small costs keep two digits. */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return '0.00';
  if (cost >= 0.01) return cost.toFixed(2);
  const decimals = 1 - Math.floor(Math.log10(cost));
  return decimals > 6 ? '< 0.000001' : cost.toFixed(decimals);
}

export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${formatNumber(count)} ${count === 1 ? noun : nouns}`;
}

/**
 * Plain text inside Markdown: characters that would start code, emphasis, links or HTML are escaped, so text like
 * `Array<string>` or `*.ts` shows as written.
 */
export function escapeText(text: string): string {
  return text.replace(/[\\`*<[\]]/g, '\\$&');
}

/** Markdown in a table cell: `|` escaped and line breaks as `<br>`, so the cell stays on its row. */
export function escapeCell(markdown: string): string {
  // Not trim(): it would also remove the no-break spaces that indent nested blocks.
  return markdown
    .replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n|\r/g, '<br>');
}

/** One line: whitespace runs (line breaks included) become one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The first `max` characters plus "…", one less when the cut would split a surrogate pair. */
export function cutChars(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '…';
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** Inline code; the delimiter is longer than any backtick run inside. */
export function code(text: string): string {
  const ticks = '`'.repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** A fenced code block; the fence is longer than any backtick run inside the content. */
export function fence(content: string, language = ''): string {
  const ticks = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${ticks}${language}\n${content.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n${ticks}`;
}

function longestBacktickRun(text: string): number {
  // A loop, not Math.max(...runs): spreading many runs overflows the call stack.
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** A Markdown table of Markdown cells (see escapeCell). */
export function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}
