import { type FocusEvent, useLayoutEffect, useRef } from 'react';

/**
 * Keeps the keyboard focus in the run controls when Run (or Simulate) turns into Stop as a run starts, and back
 * when it ends: the focused button leaves the page in that swap, which would drop the focus on the body. Focus
 * that has moved elsewhere is left alone.
 */
export function useRunControlsFocus(running: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  /** The control that had the focus last, while the focus is in the run controls. */
  const focused = useRef<HTMLElement | null>(null);

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    focused.current = event.target;
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node) {
      if (!ref.current?.contains(next)) focused.current = null;
      return;
    }
    // Focus went nowhere: a click on the page (the control is still there) or the swap (the control is gone).
    const target = event.target;
    setTimeout(() => {
      if (target.isConnected && focused.current === target) focused.current = null;
    });
  };

  useLayoutEffect(() => {
    const before = focused.current;
    if (!before || before.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [running]);

  return { ref, onFocus, onBlur };
}
