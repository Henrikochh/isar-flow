import { type RefObject, useEffect, useRef } from 'react';
import { useWorkflowState } from '../store';
import { cardElement } from './useCanvasKeyboard';

/** How long the canvas leaves the view alone after the user scrolled it. */
const HANDS_OFF_MS = 5000;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * During a live run, scrolls each block that starts into view, unless the user scrolled the canvas in the
 * last few seconds (they are looking at something else). Scrolls instantly when motion is reduced.
 */
export function useFollowRun(scrollRef: RefObject<HTMLElement | null>): void {
  const { run, runLive } = useWorkflowState();
  const userScrolledAt = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mark = () => {
      userScrolledAt.current = Date.now();
    };
    // A press on the scroll container itself rather than on its content is a scrollbar drag.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === el) mark();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) mark();
    };
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('wheel', mark);
      el.removeEventListener('touchmove', mark);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [scrollRef]);

  const active = runLive && run?.status === 'running' ? run.activeStepId : undefined;
  useEffect(() => {
    if (!active || Date.now() - userScrolledAt.current < HANDS_OFF_MS) return;
    cardElement(scrollRef.current, active)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [active, scrollRef]);
}
