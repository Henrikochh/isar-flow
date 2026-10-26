import { useCallback, useEffect, useRef, useState } from 'react';

export interface RowsDraftOptions<R> {
  /** Rows the user added but has not filled in yet; they stay local and are never committed. */
  isBlank: (row: R) => boolean;
  /** When false the local rows are kept (and shown with their problems) instead of being committed. */
  isValid?: (rows: R[]) => boolean;
  delay?: number;
}

/**
 * Local editing state for a list whose source of truth is the host document (inputs, environment variables,
 * JSON fields, …). Like useDraft: text edits commit after a short pause or on flush (blur), and while one is
 * being typed incoming updates are ignored, also the document's normalized echo of a paused commit (trimmed
 * names). Structural edits (remove, select changes) commit at once and end the typing.
 */
export function useRowsDraft<R>(source: R[], commit: (rows: R[]) => void, options: RowsDraftOptions<R>) {
  const { isBlank, isValid, delay = 350 } = options;
  const [rows, setRows] = useState<R[]>(source);
  const rowsRef = useRef(rows);
  const dirty = useRef(false);
  const typing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const sourceKey = JSON.stringify(source);
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  const latest = useRef({ commit, isBlank, isValid });
  latest.current = { commit, isBlank, isValid };

  const apply = (next: R[]) => {
    rowsRef.current = next;
    setRows(next);
  };
  const resync = () =>
    apply([...sourceRef.current, ...rowsRef.current.filter((row) => latest.current.isBlank(row))]);

  useEffect(() => {
    if (dirty.current || typing.current) return;
    resync();
    // Only a changed document should reset the rows.
  }, [sourceKey]);

  /** Commits complete, valid rows; returns whether anything was committed. */
  const commitPending = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (!dirty.current) return false;
    const { commit: send, isBlank: blank, isValid: valid } = latest.current;
    if (valid && !valid(rowsRef.current)) return false;
    dirty.current = false;
    const complete = rowsRef.current.filter((row) => !blank(row));
    if (JSON.stringify(complete) === sourceKeyRef.current) return false;
    send(complete);
    return true;
  }, []);

  const flush = useCallback(() => {
    const wasTyping = typing.current;
    typing.current = false;
    // With nothing new to commit, show the document's rows now (it may have normalized the last commit).
    if (!commitPending() && wasTyping && !dirty.current) resync();
  }, [commitPending]);

  const schedule = useCallback(
    (mode: 'idle' | 'now') => {
      dirty.current = true;
      if (timer.current) clearTimeout(timer.current);
      if (mode === 'now') flush();
      else {
        typing.current = true;
        timer.current = setTimeout(commitPending, delay);
      }
    },
    [delay, flush, commitPending],
  );

  const update = useCallback(
    (index: number, patch: Partial<R>, mode: 'idle' | 'now' = 'idle') => {
      apply(rowsRef.current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
      schedule(mode);
    },
    [schedule],
  );

  const replace = useCallback(
    (index: number, row: R, mode: 'idle' | 'now' = 'now') => {
      apply(rowsRef.current.map((current, i) => (i === index ? row : current)));
      schedule(mode);
    },
    [schedule],
  );

  const add = useCallback((row: R) => apply([...rowsRef.current, row]), []);

  const remove = useCallback(
    (index: number) => {
      apply(rowsRef.current.filter((_, i) => i !== index));
      schedule('now');
    },
    [schedule],
  );

  useEffect(() => () => flush(), [flush]);

  return { rows, update, replace, add, remove, flush };
}
