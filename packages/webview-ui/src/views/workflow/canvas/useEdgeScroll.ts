import { type RefObject, useEffect, useRef } from 'react';
import { useDndContext } from '@dnd-kit/core';

const EDGE = 56;
const MAX_STEP = 18;

function step(distance: number): number {
  return distance < EDGE ? Math.ceil(((EDGE - Math.max(0, distance)) / EDGE) * MAX_STEP) : 0;
}

/**
 * Scrolls the canvas while something is dragged near its edges. dnd-kit only scrolls the dragged node's own
 * ancestors, which leaves palette drags stuck; this covers every drag and re-measures the drop slots after
 * each scroll so the slot under the pointer stays accurate.
 */
export function useEdgeScroll(scrollRef: RefObject<HTMLElement | null>, active: boolean): void {
  const { measureDroppableContainers, droppableContainers } = useDndContext();
  const measure = useRef(measureDroppableContainers);
  measure.current = measureDroppableContainers;
  const containers = useRef(droppableContainers);
  containers.current = droppableContainers;

  useEffect(() => {
    const el = scrollRef.current;
    if (!active || !el) return;
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
    };
    const tick = () => {
      if (pointer) {
        const r = el.getBoundingClientRect();
        const inX = pointer.x >= r.left && pointer.x <= r.right;
        const inY = pointer.y >= r.top && pointer.y <= r.bottom;
        const dy = inX ? step(r.bottom - pointer.y) - step(pointer.y - r.top) : 0;
        const dx = inY ? step(r.right - pointer.x) - step(pointer.x - r.left) : 0;
        if (dx || dy) el.scrollBy(dx, dy);
      }
      frame = requestAnimationFrame(tick);
    };
    const onScroll = () => measure.current(containers.current.getEnabled().map((c) => c.id));
    window.addEventListener('pointermove', onMove);
    el.addEventListener('scroll', onScroll);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      el.removeEventListener('scroll', onScroll);
    };
  }, [active, scrollRef]);
}
