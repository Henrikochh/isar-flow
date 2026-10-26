import { useEffect, useState } from 'react';

/** Current time, refreshed periodically so relative times ("4 min ago") stay correct. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Catch up at once when the interval changes, e.g. when a run starts and elapsed times begin to tick.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
