import { type ReactNode, useEffect, useRef } from 'react';
import { IconButton } from './Button';

/** Modal dialog with Escape to close and focus moved inside on open. */
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

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-dialog-close]), [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    return () => previous?.focus?.();
  }, []);

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
        aria-labelledby="if-dialog-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="if-dialog__header">
          {icon}
          <h2 className="if-dialog__title" id="if-dialog-title">
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
