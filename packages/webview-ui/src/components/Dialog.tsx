import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { IconButton } from './Button';

const FOCUSABLE =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function tabStops(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest('[hidden]'),
  );
  const shown = candidates.filter((el) => el.getClientRects().length > 0);
  // jsdom has no layout; there every candidate counts.
  return shown.length ? shown : candidates;
}

/** Modal dialog: focus moves inside on open, Tab cycles within it, Escape closes it and focus returns. */
export function Dialog({
  title,
  icon,
  children,
  footer,
  onClose,
}: {
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const previous = useRef<HTMLElement | null>(null);

  // Before the first paint: no frame shows the dialog while keys still go to the button that opened it.
  useLayoutEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-dialog-close]), [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, []);

  // Back where it came from on close; after the commit, so React sees that focus (its events are off during one).
  useEffect(() => () => previous.current?.focus?.(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const stops = tabStops(ref.current);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !ref.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !ref.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="if-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="if-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="if-dialog__header">
          {icon}
          <h2 className="if-dialog__title" id={titleId}>
            {title}
          </h2>
          <IconButton icon="close" label="Close" onClick={onClose} data-dialog-close />
        </div>
        <div className="if-dialog__body">{children}</div>
        {footer ? <div className="if-dialog__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
