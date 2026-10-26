import './popover.css';
import { type KeyboardEvent, type ReactNode, useRef } from 'react';

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"])';

/** List of actions with arrow-key, Home and End navigation. Put it inside a Popover with role="none". */
export function Menu({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const go = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(index + 1);
    else if (event.key === 'ArrowUp') go(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
  };
  return (
    <div
      ref={ref}
      className={['if-menu', className].filter(Boolean).join(' ')}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  description,
  leading,
  meta,
  onSelect,
  disabled,
  current,
  title,
  wrap,
}: {
  children: ReactNode;
  description?: ReactNode;
  /** Icon, stone or status glyph shown before the label. */
  leading?: ReactNode;
  /** Right-aligned secondary content. */
  meta?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Marks the item that matches the current state (e.g. the run being shown). */
  current?: boolean;
  title?: string;
  /** Let long labels wrap instead of truncating them (e.g. problem messages). */
  wrap?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={['if-menu__item', current && 'if-menu__item--current', wrap && 'if-menu__item--wrap']
        .filter(Boolean)
        .join(' ')}
      aria-disabled={disabled || undefined}
      aria-current={current || undefined}
      title={title}
      tabIndex={-1}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      {leading ? <span className="if-menu__leading">{leading}</span> : null}
      <span className="if-menu__text">
        <span className="if-menu__label">{children}</span>
        {description ? <span className="if-menu__desc">{description}</span> : null}
      </span>
      {meta ? <span className="if-menu__meta">{meta}</span> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="if-menu__label-row" role="presentation">
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div className="if-menu__separator" role="separator" />;
}
