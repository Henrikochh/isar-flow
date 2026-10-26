import { type ReactNode, useEffect, useRef } from 'react';
import { Button } from '../../components';

/** Inline confirmation that takes the place of a row before a destructive action. */
export function ConfirmStrip({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className="sb-confirm"
      role="group"
      aria-label={typeof title === 'string' ? title : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="sb-confirm__title">{title}</div>
      {children ? <div className="sb-confirm__body">{children}</div> : null}
      <div className="sb-confirm__actions">
        <Button variant="danger" size="s" icon="trash" onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button ref={cancelRef} variant="ghost" size="s" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
