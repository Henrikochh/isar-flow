import { DURATION_PATTERN } from '../schema/zod';

/** Schedules fire at most once a minute. */
export const MIN_SCHEDULE_MS = 60_000;

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A schedule's `every` ("15m", "1h30m", "1d") in milliseconds; undefined when it isn't one or is 0. */
export function parseDuration(text: string): number | undefined {
  if (typeof text !== 'string' || !DURATION_PATTERN.test(text)) return undefined;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)([smhd])/g)) total += Number(amount) * UNIT_MS[unit];
  return total > 0 && Number.isSafeInteger(total) ? total : undefined;
}

interface Unit {
  seconds: number;
  /** Used when the duration has several parts, and for amounts above 1 without a plural. */
  short: string;
  /** For an amount of exactly 1 ("Every hour"). */
  word: string;
  /** For a single part above 1 ("Every 2 hours"). */
  plural?: string;
}

const UNITS: Unit[] = [
  { seconds: 86_400, short: 'd', word: 'day', plural: 'days' },
  { seconds: 3_600, short: 'h', word: 'hour', plural: 'hours' },
  { seconds: 60, short: 'min', word: 'minute' },
  { seconds: 1, short: 's', word: 'second' },
];

/** "Every 15 min", "Every hour", "Every 2 hours", "Every 1 h 30 min", "Every day", "Every 1 min 30 s". */
export function formatEvery(ms: number): string {
  let rest = Number.isFinite(ms) ? Math.max(1, Math.round(ms / 1000)) : 1;
  const parts: { unit: Unit; amount: number }[] = [];
  for (const unit of UNITS) {
    const amount = Math.floor(rest / unit.seconds);
    rest -= amount * unit.seconds;
    if (amount > 0) parts.push({ unit, amount });
  }
  if (parts.length === 1) {
    const [{ unit, amount }] = parts;
    if (amount === 1) return `Every ${unit.word}`;
    return `Every ${amount} ${unit.plural ?? unit.short}`;
  }
  return `Every ${parts.map(({ unit, amount }) => `${amount} ${unit.short}`).join(' ')}`;
}
