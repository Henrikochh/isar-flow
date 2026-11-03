/** The schedule ticker checks every 15 s, so a scheduled run starts at most 15 s late. */
export const SCHEDULE_TICK_MS = 15_000;

/** How many due times of a schedule have passed at `now` (0: not due yet; more than 1 after a sleep). */
export function dueCount(nextRunAt: number, everyMs: number, now: number): number {
  return now < nextRunAt ? 0 : Math.floor((now - nextRunAt) / everyMs) + 1;
}
