import { useCallback, useEffect, useRef, useState } from 'react';

export interface HoverTarget {
  anchor: HTMLElement;
  expression: string;
}

const TIP_SELECTOR = '.wf-livetip';

/**
 * Hover card timing: opens after `delay` ms on a target, stays while the pointer moves onto the card (`grace` ms
 * to get there), and closes when the pointer leaves, on Escape, on a press elsewhere and when the page scrolls.
 */
export function useHoverTip(delay = 300, grace = 150) {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancel = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);

  const close = useCallback(() => {
    cancel();
    setTarget(null);
  }, [cancel]);

  const enter = useCallback(
    (anchor: HTMLElement, expression: string) => {
      cancel();
      openTimer.current = setTimeout(() => setTarget({ anchor, expression }), delay);
    },
    [cancel, delay],
  );

  /** The pointer left the target or the card. */
  const leave = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setTarget(null), grace);
  }, [grace]);

  /** The pointer reached the card. */
  const keep = useCallback(() => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!target) return;
    const inTip = (event: Event) => event.target instanceof Element && event.target.closest(TIP_SELECTOR);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onScroll = (event: Event) => {
      if (!inTip(event)) close();
    };
    const onDown = (event: Event) => {
      if (!inTip(event)) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [target, close]);

  useEffect(() => cancel, [cancel]);

  return { target, enter, leave, keep, close };
}
