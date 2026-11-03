import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Local editing state for a field whose source of truth lives in the host document. Changes are committed
 * after `delay` ms of inactivity and on flush (blur, Enter, unmount). From the first change until that flush
 * the field owns its text: incoming values are ignored, so neither a slow round-trip nor the document's
 * normalized echo of a paused commit (a trimmed trailing space) changes what is being typed.
 */
export function useDraft<T>(value: T, commit: (value: T) => void, delay = 350) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(value);
  const incoming = useRef(value);
  incoming.current = value;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  /** Commits pending text; returns whether anything was committed. */
  const commitPending = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (!dirty.current) return false;
    dirty.current = false;
    commitRef.current(latest.current);
    return true;
  }, []);

  const flush = useCallback(() => {
    const wasEditing = editing.current;
    editing.current = false;
    // With nothing new to commit, show the document's value now (it may have normalized the last commit).
    if (!commitPending() && wasEditing) setDraft(incoming.current);
  }, [commitPending]);

  const change = useCallback(
    (next: T) => {
      dirty.current = true;
      editing.current = true;
      latest.current = next;
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(commitPending, delay);
    },
    [delay, commitPending],
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

/**
 * An estimated cost without a currency symbol (prices are in whatever unit the user wrote them): two decimals,
 * and two significant digits below a cent so small runs never read as "0.00".
 */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return '0.00';
  if (cost >= 0.01) return cost.toFixed(2);
  const decimals = 1 - Math.floor(Math.log10(cost));
  return decimals > 6 ? '< 0.000001' : cost.toFixed(decimals);
}

/** A file size: "820 bytes", "1.3 KB", "12 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
