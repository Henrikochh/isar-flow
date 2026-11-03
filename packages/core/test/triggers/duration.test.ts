import { describe, expect, it } from 'vitest';
import { formatEvery, MIN_SCHEDULE_MS, parseDuration } from '../../src/triggers';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('parseDuration', () => {
  it.each([
    ['30s', 30 * SECOND],
    ['1m', MINUTE],
    ['15m', 15 * MINUTE],
    ['1h', HOUR],
    ['1h30m', HOUR + 30 * MINUTE],
    ['1d', DAY],
    ['2d12h', 2 * DAY + 12 * HOUR],
    ['90m', 90 * MINUTE],
    ['1m30s', MINUTE + 30 * SECOND],
    ['0h5m', 5 * MINUTE],
    ['1h1h', 2 * HOUR],
  ])('reads %s', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each([
    '',
    '0m',
    '0s0m',
    '15',
    'm',
    '15 m',
    ' 15m',
    '15m ',
    '1.5h',
    '-1m',
    '15M',
    '1w',
    '1h 30m',
    'every 15m',
  ])('rejects %j', (text) => {
    expect(parseDuration(text)).toBeUndefined();
  });

  it('rejects values that are not text and durations too long to count', () => {
    expect(parseDuration(15 as unknown as string)).toBeUndefined();
    expect(parseDuration(undefined as unknown as string)).toBeUndefined();
    expect(parseDuration(`${'9'.repeat(400)}d`)).toBeUndefined();
  });

  it('has a one-minute minimum for schedules', () => {
    expect(MIN_SCHEDULE_MS).toBe(60_000);
    expect(parseDuration('1m')).toBe(MIN_SCHEDULE_MS);
  });
});

describe('formatEvery', () => {
  it.each([
    [SECOND, 'Every second'],
    [MINUTE, 'Every minute'],
    [HOUR, 'Every hour'],
    [DAY, 'Every day'],
    [30 * SECOND, 'Every 30 s'],
    [15 * MINUTE, 'Every 15 min'],
    [2 * HOUR, 'Every 2 hours'],
    [3 * DAY, 'Every 3 days'],
    [HOUR + 30 * MINUTE, 'Every 1 h 30 min'],
    [MINUTE + 30 * SECOND, 'Every 1 min 30 s'],
    [DAY + 2 * HOUR, 'Every 1 d 2 h'],
    [2 * DAY + 30 * SECOND, 'Every 2 d 30 s'],
    [90 * MINUTE, 'Every 1 h 30 min'],
    [24 * HOUR, 'Every day'],
  ])('formats %d ms as %j', (ms, text) => {
    expect(formatEvery(ms)).toBe(text);
  });

  it('rounds to whole seconds and never shows less than a second', () => {
    expect(formatEvery(MINUTE + 400)).toBe('Every minute');
    expect(formatEvery(1)).toBe('Every second');
    expect(formatEvery(0)).toBe('Every second');
    expect(formatEvery(Number.NaN)).toBe('Every second');
  });

  it('formats what parseDuration reads', () => {
    expect(formatEvery(parseDuration('1h30m') ?? 0)).toBe('Every 1 h 30 min');
    expect(formatEvery(parseDuration('60m') ?? 0)).toBe('Every hour');
  });
});
