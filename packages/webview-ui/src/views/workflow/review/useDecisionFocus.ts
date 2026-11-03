import { useEffect, useRef } from 'react';
import type { RunReview } from '@isar-flow/core';

/**
 * Keeps the keyboard in the card across a decision: while the host applies it the buttons are disabled (the
 * browser drops their focus) and a decided file loses them. Once the review settles, the file that was decided
 * (if it is still pending, e.g. after a failure), else the next pending file takes the focus; with none left, the
 * toggle of the folded card does. Focus that moved out of the card is left alone.
 */
export function useDecisionFocus(review: RunReview) {
  const container = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const target = useRef<{ path: string | null } | null>(null);

  useEffect(() => {
    const wanted = target.current;
    const root = container.current;
    if (!wanted || review.busy || !root) return;
    target.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !root.contains(active)) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('li[data-path]'));
    const start = Math.max(
      0,
      rows.findIndex((row) => row.dataset.path === wanted.path),
    );
    const next = [...rows.slice(start), ...rows.slice(0, start)]
      .map((row) => row.querySelector<HTMLButtonElement>('.wf-review-actions button:not(:disabled)'))
      .find((button) => button !== null);
    (next ?? toggle.current)?.focus();
  }, [review]);

  return {
    container,
    toggle,
    /** Call before posting a decision about `path` (null: every pending file). */
    expect: (path: string | null) => {
      target.current = { path };
    },
  };
}
