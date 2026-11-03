import { describe, expect, it } from 'vitest';
import { runReportFileName } from '../../src/report';
import {
  code,
  cutChars,
  escapeCell,
  escapeText,
  fence,
  formatCost,
  formatDuration,
  formatNumber,
  formatUtcTime,
  table,
} from '../../src/report/format';

describe('report formatting', () => {
  it('formats numbers, durations, costs and times', () => {
    expect(formatNumber(1234567.4)).toBe('1,234,567');
    expect(formatNumber(999)).toBe('999');
    expect(
      [0, 450, 1000, 12_340, 59_949, 59_950, 252_000, 3_599_000, 3_600_000, 3_900_000].map(formatDuration),
    ).toEqual(['0ms', '450ms', '1s', '12.3s', '59.9s', '1m 0s', '4m 12s', '59m 59s', '1h 0m', '1h 5m']);
    expect(formatDuration(-5)).toBe('0ms');
    expect([0, 1.234, 0.0042, 0.00042, 0.0000001].map(formatCost)).toEqual([
      '0.00',
      '1.23',
      '0.0042',
      '0.00042',
      '< 0.000001',
    ]);
    expect(formatUtcTime(Date.UTC(2026, 0, 5, 7, 3))).toBe('2026-01-05 07:03 UTC');
    expect(formatUtcTime(Number.NaN)).toBe('unknown time');
  });

  it('escapes text, cells, inline code and fences', () => {
    expect(escapeText('a *b* `c` <d> [e] \\f')).toBe('a \\*b\\* \\`c\\` \\<d> \\[e\\] \\\\f');
    expect(escapeCell(' a|b\r\nc\nd ')).toBe('a\\|b<br>c<br>d');
    expect(escapeCell('  x')).toBe('  x');
    expect(code('a')).toBe('`a`');
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`a')).toBe('`` `a ``');
    expect(fence('x\r\ny\n\n')).toBe('```\nx\ny\n```');
    expect(fence('has ```` four', 'md')).toBe('`````md\nhas ```` four\n`````');
    expect(table(['A', 'B'], [['1', 'x|y']])).toBe('| A | B |\n| --- | --- |\n| 1 | x\\|y |');
  });

  it('cuts text without splitting surrogate pairs', () => {
    expect(cutChars('abc', 3)).toBe('abc');
    expect(cutChars('abcd ', 4)).toBe('abcd…');
    expect(cutChars('ab cd', 3)).toBe('ab…');
    expect(cutChars('a😀', 2)).toBe('a…');
    expect(cutChars('abc', 0)).toBe('…');
  });
});

describe('runReportFileName', () => {
  it('is the workflow name as a slug and the local start time', () => {
    const startedAt = new Date(2026, 10, 3, 9, 5).getTime();
    expect(runReportFileName({ workflowName: 'Review loop', startedAt })).toBe(
      'review-loop-run-2026-11-03-0905.md',
    );
    expect(runReportFileName({ workflowName: 'Überprüfung: Läufe & Tests!', startedAt })).toBe(
      'uberprufung-laufe-tests-run-2026-11-03-0905.md',
    );
    expect(runReportFileName({ workflowName: '  ', startedAt })).toBe('workflow-run-2026-11-03-0905.md');
    expect(runReportFileName({ workflowName: '日本語', startedAt })).toBe('workflow-run-2026-11-03-0905.md');
    expect(runReportFileName({ workflowName: `${'a'.repeat(59)} b`, startedAt })).toBe(
      `${'a'.repeat(59)}-run-2026-11-03-0905.md`,
    );
    expect(runReportFileName({ workflowName: 'x', startedAt: Number.NaN })).toBe('x-run-unknown.md');
  });
});
