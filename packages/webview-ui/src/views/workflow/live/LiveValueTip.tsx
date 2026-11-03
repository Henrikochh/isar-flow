/**
 * Hover card with the value a template had in a run. A tooltip: nothing in it takes the focus, and it stays open
 * while the pointer moves onto it (so long values can be scrolled). The kit Popover moves the focus into its
 * panel, which a hover card must not do, so this one has its own small portal with the same look.
 */
import { type SyntheticEvent, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LiveValue } from '@isar-flow/core';
import type { LiveSnapshot } from './LiveDataProvider';
import { LiveRunLabel, LiveValueView, liveTypeLabel } from './LiveValueView';

export interface LiveValueTipProps {
  anchor: HTMLElement;
  snapshot: LiveSnapshot;
  /** The source between `${{` and `}}`. */
  expression: string;
  value: LiveValue;
  id?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const GAP = 6;
const MARGIN = 8;

const stop = (event: SyntheticEvent) => event.stopPropagation();

/** Below the anchor, or above it when there is more room there; always inside the window. */
export function placeTip(
  anchor: DOMRect,
  width: number,
  height: number,
  view = { width: window.innerWidth, height: window.innerHeight },
): { top: number; left: number } {
  const below = view.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const top =
    height > below && above > below ? Math.max(MARGIN, anchor.top - GAP - height) : anchor.bottom + GAP;
  const left = Math.max(MARGIN, Math.min(anchor.left, view.width - width - MARGIN));
  return { top, left };
}

export function LiveValueTip({
  anchor,
  snapshot,
  expression,
  value,
  id,
  onMouseEnter,
  onMouseLeave,
}: LiveValueTipProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    setPosition(placeTip(anchor.getBoundingClientRect(), panel.offsetWidth, panel.offsetHeight));
  }, [anchor, value, snapshot]);

  const type = liveTypeLabel(value);
  return createPortal(
    // React events bubble through portals: keep presses on the card from selecting or dragging the block under it.
    <div
      ref={panelRef}
      id={id}
      role="tooltip"
      className="wf-livetip"
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      <LiveRunLabel snapshot={snapshot} />
      <div className="wf-livetip__expr">
        <code className="wf-livetip__code">{expression}</code>
        {type ? <span className="wf-live-type">{type}</span> : null}
      </div>
      <LiveValueView value={value} />
    </div>,
    document.body,
  );
}
