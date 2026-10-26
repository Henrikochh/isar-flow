/** Formatting helpers for the run terminal, status bar and log. */

const ESC = '\x1b[';
export const dim = (text: string) => `${ESC}2m${text}${ESC}0m`;
export const green = (text: string) => `${ESC}32m${text}${ESC}0m`;
export const red = (text: string) => `${ESC}31m${text}${ESC}0m`;

/** Pseudoterminals need CRLF line breaks. */
export function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** "1.2 s" below a minute, "2 m 5 s" above. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${seconds % 60} s`;
}

/** Clock style for the status bar: "0:42", "12:05", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
