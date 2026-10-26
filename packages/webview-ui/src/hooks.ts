import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Local editing state for a field whose source of truth lives in the host document. While the user is
 * editing (dirty), incoming value updates are ignored so a slow round-trip never clobbers typing;
 * changes are committed after `delay` ms of inactivity and on flush (blur).
 */
export function useDraft<T>(value: T, commit: (value: T) => void, delay = 350) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(value);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (dirty.current) {
      dirty.current = false;
      commitRef.current(latest.current);
    }
  }, []);

  const change = useCallback(
    (next: T) => {
      dirty.current = true;
      latest.current = next;
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [delay, flush],
  );

  useEffect(() => () => flush(), [flush]);

  return { value: draft, change, flush };
}

/** Formats a duration in ms as "820 ms", "4.2 s" or "3 m 12 s". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${seconds} s`;
}

/** "just now", "5 min ago", "2 h ago", or a short date. */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
