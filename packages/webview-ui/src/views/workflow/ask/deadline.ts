/** Time left as a clock: "2:30", "0:05", "1:06:40". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** The muted line under an ask: how long is left and what happens then. */
export function deadlineText(expiresAt: number, now: number, fallback: string | undefined): string {
  const left = expiresAt - now;
  const then = fallback !== undefined ? `'${fallback}' is used` : 'the block fails';
  return left > 0 ? `Answer within ${formatCountdown(left)}; then ${then}.` : `Time is up; ${then}.`;
}
