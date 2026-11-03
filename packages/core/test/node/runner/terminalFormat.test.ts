import { describe, expect, it } from 'vitest';
import {
  formatCommandHeader,
  formatDuration,
  formatExitFooter,
  startsOnNewLine,
  toTerminalText,
} from '../../../src/node/runner/terminalFormat';

describe('terminal formatting', () => {
  it('formats the command header dimmed with continuation lines aligned', () => {
    expect(formatCommandHeader('build', 'npm ci\nnpm test\n')).toBe(
      '\x1b[2m[build] $ npm ci\n          npm test\x1b[0m\n',
    );
  });

  it('formats a successful exit in green and a failure in red', () => {
    expect(formatExitFooter(0, 1234)).toBe('\x1b[32m✓ Exit code 0\x1b[0m\x1b[2m · 1.2 s\x1b[0m\n\n');
    expect(formatExitFooter(2, 80)).toBe('\x1b[31m✗ Exit code 2\x1b[0m\x1b[2m · 80 ms\x1b[0m\n\n');
  });

  it('formats durations', () => {
    expect(formatDuration(999)).toBe('999 ms');
    expect(formatDuration(59_940)).toBe('59.9 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });

  it('turns every newline into CRLF once', () => {
    expect(toTerminalText('a\nb\r\nc')).toBe('a\r\nb\r\nc');
  });

  it('remembers recent headers and footers so they start on a new line', () => {
    const header = formatCommandHeader('lint', 'npm run lint');
    expect(startsOnNewLine(header)).toBe(true);
    expect(startsOnNewLine('plain output\n')).toBe(false);
    for (let i = 0; i < 70; i++) formatCommandHeader(`step${i}`, 'echo');
    expect(startsOnNewLine(header)).toBe(false);
  });
});
