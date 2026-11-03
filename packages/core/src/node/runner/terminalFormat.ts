const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

/** Header and footer strings handed out recently; the terminal starts these on a fresh line. */
const lineStarts = new Set<string>();
const MAX_REMEMBERED = 64;

function remember(text: string): string {
  lineStarts.delete(text);
  lineStarts.add(text);
  if (lineStarts.size > MAX_REMEMBERED) lineStarts.delete(lineStarts.values().next().value as string);
  return text;
}

/** True for strings from formatCommandHeader/formatExitFooter, which must not continue a partial line. */
export function startsOnNewLine(text: string): boolean {
  return lineStarts.has(text);
}

/** Terminals need CRLF; turns every LF (and CRLF) into exactly one CRLF. */
export function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Dimmed `[step] $ command` line; further command lines are aligned under the first. */
export function formatCommandHeader(stepId: string, command: string): string {
  const prefix = `[${stepId}] $ `;
  const lines = command.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const body = lines.map((line, i) => (i === 0 ? prefix : ' '.repeat(prefix.length)) + line).join('\n');
  return remember(`${DIM}${body}${RESET}\n`);
}

/** Green check for exit code 0, red cross otherwise, then the duration; ends with a blank line. */
export function formatExitFooter(exitCode: number, durationMs: number): string {
  const status = exitCode === 0 ? `${GREEN}✓ Exit code 0` : `${RED}✗ Exit code ${exitCode}`;
  return remember(`${status}${RESET}${DIM} · ${formatDuration(durationMs)}${RESET}\n\n`);
}
