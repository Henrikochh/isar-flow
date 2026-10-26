import { type RefObject, useCallback, useEffect, useState } from 'react';
import { patchEditorState, readEditorState } from '../viewState';

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 1.5;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

/**
 * Canvas zoom (CSS `zoom` on the river) with Ctrl/Cmd + wheel, persisted in the webview state.
 * `fit` scales the river so it fits the visible canvas.
 */
export function useZoom(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>) {
  const [zoom, setZoomState] = useState(() => clampZoom(readEditorState().zoom ?? 1));

  const setZoom = useCallback((next: number | ((current: number) => number)) => {
    setZoomState((current) => clampZoom(typeof next === 'function' ? next(current) : next));
  }, []);

  useEffect(() => {
    if (readEditorState().zoom !== zoom) patchEditorState({ zoom });
  }, [zoom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((z) => z * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollRef, setZoom]);

  const fit = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const rect = content.getBoundingClientRect();
    const width = rect.width / zoom;
    const height = rect.height / zoom;
    if (!width || !height) return;
    const padding = 96;
    setZoom(Math.min((scroller.clientWidth - padding) / width, (scroller.clientHeight - padding) / height));
  }, [scrollRef, contentRef, zoom, setZoom]);

  return { zoom, setZoom, fit };
}
