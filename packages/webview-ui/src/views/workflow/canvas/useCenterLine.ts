import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

interface Metrics {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}

/** How far the river's center line sits right of the middle of the visible canvas. */
function centerOffset({ scrollWidth, clientWidth, scrollLeft }: Metrics): number {
  return scrollWidth / 2 - scrollLeft - clientWidth / 2;
}

/** The scroll position that puts the center line `offset` px right of the middle, within the scroll range. */
function scrollLeftFor({ scrollWidth, clientWidth }: Metrics, offset: number): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.min(max, Math.max(0, scrollWidth / 2 - clientWidth / 2 - offset));
}

/**
 * Keeps the river's center line where it is on screen when the river or the canvas changes width (an edit adds
 * an If, the zoom changes, the window is resized). The river starts centered; scrolling sideways moves the line
 * and later changes keep the new place. Runs before paint, so selected blocks are revealed from the kept position.
 */
export function useCenterLine(
  scrollRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
) {
  const offset = useRef(0);
  const size = useRef({ scrollWidth: -1, clientWidth: -1 });

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollWidth, clientWidth } = el;
    if (scrollWidth === size.current.scrollWidth && clientWidth === size.current.clientWidth) return;
    size.current = { scrollWidth, clientWidth };
    el.scrollLeft = scrollLeftFor(el, offset.current);
    offset.current = centerOffset(el);
  }, [scrollRef]);

  // Every render of the canvas may have changed the river's width.
  useLayoutEffect(sync);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const remember = () => {
      offset.current = centerOffset(el);
    };
    el.addEventListener('scroll', remember, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    observer?.observe(el);
    if (stageRef.current) observer?.observe(stageRef.current);
    return () => {
      el.removeEventListener('scroll', remember);
      observer?.disconnect();
    };
  }, [scrollRef, stageRef, sync]);
}
