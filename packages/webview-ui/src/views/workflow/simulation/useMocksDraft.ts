import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimulationResult } from '@isar-flow/core';
import { type MockRow, rowFromResult, toResults } from './mockRows';

export type CommitMode = 'idle' | 'now';

/**
 * Local editing state of a block's mocks, like useRowsDraft: typing commits after `delay` ms or on flush (blur),
 * structural edits commit at once, and while rows are being edited (or can't be saved) incoming results are
 * ignored. The host's echo of the last commit keeps the local rows, so typed text and the values hidden while
 * a call fails survive the round trip.
 */
export function useMocksDraft(
  source: SimulationResult[],
  commit: (results: SimulationResult[]) => void,
  isValid: (rows: MockRow[]) => boolean,
  delay = 350,
) {
  const nextKey = useRef(0);
  const fromSource = (results: SimulationResult[]) => results.map((r) => rowFromResult(r, nextKey.current++));
  const [rows, setRows] = useState<MockRow[]>(() => fromSource(source));
  const rowsRef = useRef(rows);
  const dirty = useRef(false);
  const typing = useRef(false);
  const sent = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourceKey = JSON.stringify(source);
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const latest = useRef({ commit, isValid });
  latest.current = { commit, isValid };

  const apply = (next: MockRow[]) => {
    rowsRef.current = next;
    setRows(next);
  };

  useEffect(() => {
    if (dirty.current || typing.current || sourceKey === sent.current) return;
    sent.current = null;
    apply(fromSource(sourceRef.current));
    // Only changed results should reset the rows.
  }, [sourceKey]);

  /** Commits valid rows that differ from the source; returns whether anything was sent. */
  const commitPending = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!dirty.current || !latest.current.isValid(rowsRef.current)) return false;
    dirty.current = false;
    const results = toResults(rowsRef.current);
    const key = JSON.stringify(results);
    if (key === sourceKeyRef.current) return false;
    sent.current = key;
    latest.current.commit(results);
    return true;
  }, []);

  const flush = useCallback(() => {
    typing.current = false;
    commitPending();
  }, [commitPending]);

  const schedule = useCallback(
    (mode: CommitMode) => {
      dirty.current = true;
      clearTimeout(timer.current);
      if (mode === 'now') flush();
      else {
        typing.current = true;
        timer.current = setTimeout(commitPending, delay);
      }
    },
    [delay, flush, commitPending],
  );

  const update = useCallback(
    (index: number, change: (row: MockRow) => MockRow, mode: CommitMode = 'idle') => {
      apply(rowsRef.current.map((row, i) => (i === index ? change(row) : row)));
      schedule(mode);
    },
    [schedule],
  );

  const add = useCallback(
    (create: (key: number) => MockRow) => {
      apply([...rowsRef.current, create(nextKey.current++)]);
      schedule('now');
    },
    [schedule],
  );

  const remove = useCallback(
    (index: number) => {
      apply(rowsRef.current.filter((_, i) => i !== index));
      schedule('now');
    },
    [schedule],
  );

  const move = useCallback(
    (index: number, delta: -1 | 1) => {
      const target = index + delta;
      const next = [...rowsRef.current];
      if (target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target], next[index]];
      apply(next);
      schedule('now');
    },
    [schedule],
  );

  useEffect(() => () => flush(), [flush]);

  return { rows, update, add, remove, move, flush };
}
