import './popover.css';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'bottom';

export interface PopoverProps {
  open: boolean;
  /** Element the popover is attached to; it keeps toggling the popover itself. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  placement?: PopoverPlacement;
  /** Accessible name of the popover. */
  label: string;
  /** 'dialog' for mixed content, 'none' when the child provides its own role (e.g. a Menu). */
  role?: 'dialog' | 'none';
  width?: number;
  className?: string;
}

interface Position {
  top: number;
  left: number;
  maxHeight: number;
}

const GAP = 6;
const MARGIN = 8;

const TAB_STOPS = 'input, textarea, select, button, [href], [tabindex]';

/** True when Tab (or Shift+Tab) from the focused element would move focus out of the panel. */
function leavesPanel(panel: HTMLElement, backwards: boolean): boolean {
  const stops = Array.from(panel.querySelectorAll<HTMLElement>(TAB_STOPS)).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
  const edge = backwards ? stops[0] : stops[stops.length - 1];
  return (
    stops.length === 0 ||
    document.activeElement === edge ||
    !stops.includes(document.activeElement as HTMLElement)
  );
}

function computePosition(anchor: DOMRect, panel: HTMLElement, placement: PopoverPlacement): Position {
  const width = panel.offsetWidth;
  const height = panel.scrollHeight;
  const below = window.innerHeight - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const flip = height > below && above > below;
  let left =
    placement === 'bottom-end'
      ? anchor.right - width
      : placement === 'bottom'
        ? anchor.left + anchor.width / 2 - width / 2
        : anchor.left;
  left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
  const maxHeight = Math.max(120, flip ? above : below);
  const top = flip ? Math.max(MARGIN, anchor.top - GAP - Math.min(height, maxHeight)) : anchor.bottom + GAP;
  return { top, left, maxHeight };
}

/**
 * Floating panel anchored to an element, rendered in a portal so canvas zoom and scroll containers never clip
 * or scale it. Closes on Escape (focus returns to the anchor) and on pointer down outside.
 */
export function Popover({
  open,
  anchorRef,
  onClose,
  children,
  placement = 'bottom-start',
  label,
  role = 'dialog',
  width,
  className,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    setPosition(computePosition(anchor.getBoundingClientRect(), panel, placement));
  }, [anchorRef, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onScroll = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      place();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      // Menu items are buttons too: an aria-disabled one (e.g. Run from here without a run) never gets the focus.
      const first = panel.querySelector<HTMLElement>(
        '[data-autofocus], input, textarea, [role="menuitem"]:not([aria-disabled="true"]), button:not(:disabled):not([aria-disabled="true"])',
      );
      (first ?? panel).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      className={['if-popover', className].filter(Boolean).join(' ')}
      role={role === 'none' ? undefined : role}
      aria-label={role === 'none' ? undefined : label}
      tabIndex={-1}
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        maxHeight: position?.maxHeight,
        width,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          anchorRef.current?.focus();
        } else if (event.key === 'Tab' && leavesPanel(event.currentTarget, event.shiftKey)) {
          // The panel sits at the end of the page. Focusing the anchor without preventing the default lets the
          // browser continue the tab order from there instead of from the top of the page.
          onClose();
          anchorRef.current?.focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
