import { useEffect, useRef } from 'react';

/**
 * Moves focus into a row the user just added. Call `markAdded()` before adding; the first input of the last
 * `[data-row]` element inside the container is focused once the row count grows.
 */
export function useFocusOnAdd(count: number) {
  const containerRef = useRef<HTMLDivElement>(null);
  const added = useRef(false);
  useEffect(() => {
    if (!added.current) return;
    added.current = false;
    const rows = containerRef.current?.querySelectorAll<HTMLElement>('[data-row]');
    rows?.[rows.length - 1]?.querySelector<HTMLElement>('input, textarea, button')?.focus();
  }, [count]);
  return {
    containerRef,
    markAdded: () => {
      added.current = true;
    },
  };
}
