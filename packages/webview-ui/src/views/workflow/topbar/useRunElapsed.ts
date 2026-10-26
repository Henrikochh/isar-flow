import { useEffect, useMemo, useState } from 'react';
import type { RunView } from '@isar-flow/core';

/** Latest host timestamp known from the run (its start, block starts and block ends). */
export function latestRunTime(run: RunView): number {
  let latest = run.startedAt;
  for (const step of Object.values(run.steps)) {
    if (step.startedAt !== undefined) latest = Math.max(latest, step.startedAt + (step.durationMs ?? 0));
  }
  return latest;
}

/**
 * Elapsed time of a run, ticking every second while it runs. Measured from the host's own timestamps plus
 * the local time since the latest one, so a clock difference between host and webview does not matter.
 */
export function useRunElapsed(run: RunView | null): number | undefined {
  const running = run?.status === 'running';
  const hostTime = run ? latestRunTime(run) : 0;
  const anchor = useMemo(() => ({ hostTime, localTime: Date.now() }), [hostTime]);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!run) return undefined;
  if (!running) return run.durationMs;
  return Math.max(0, anchor.hostTime - run.startedAt + (Date.now() - anchor.localTime));
}
