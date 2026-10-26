import { useLayoutEffect, useRef, useState } from 'react';
import { fitPath } from './model';

/** Width of one character in the element's (monospace) font. */
function charWidth(el: HTMLElement): number {
  const probe = document.createElement('span');
  probe.className = 'sb-path__probe';
  probe.textContent = '0'.repeat(10);
  el.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return width;
}

/**
 * A relative path that keeps the file name visible. Leading folders are dropped whole ("…/workflows/x.yaml")
 * as the row narrows; the path is in the code font, so the number of characters that fit is exact.
 */
export function PathText({ path }: { path: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [columns, setColumns] = useState<number>();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let live = true;
    const measure = () => {
      const width = live ? charWidth(el) : 0;
      if (width > 0) setColumns(Math.floor((el.clientWidth + 0.5) / width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The code font may arrive after the first layout.
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);

  return (
    <span ref={ref} className="sb-path" title={path}>
      {columns === undefined ? path : fitPath(path, columns)}
    </span>
  );
}
