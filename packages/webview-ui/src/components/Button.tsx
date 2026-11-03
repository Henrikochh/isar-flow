import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { Spinner } from './Display';

/** `link`: inline text in the link color, for a suggestion inside a hint. */
export type ButtonVariant = 'primary' | 'run' | 'secondary' | 'ghost' | 'danger' | 'link';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 's' | 'm';
  /** Codicon name, e.g. 'play'. */
  icon?: string;
  /** Shows a spinner and ignores clicks, like `aria-disabled`. */
  loading?: boolean;
}

/**
 * `disabled` takes the button out of the tab order (the browser drops its focus). `aria-disabled` and `loading`
 * keep it focusable but ignore clicks: for a button that is busy right after it was pressed.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'm',
    icon,
    loading,
    className,
    children,
    type = 'button',
    onClick,
    ...rest
  },
  ref,
) {
  const unavailable = loading || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  const classes = ['if-btn', `if-btn--${variant}`, size === 's' && 'if-btn--s', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      {...rest}
      aria-disabled={unavailable || undefined}
      onClick={unavailable ? undefined : onClick}
    >
      {loading ? <Spinner /> : icon ? <i className={`codicon codicon-${icon}`} aria-hidden="true" /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  /** Accessible name; also shown as tooltip. */
  label: string;
  active?: boolean;
  size?: 'm' | 'l';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, active, size = 'm', className, type = 'button', ...rest },
  ref,
) {
  const classes = [
    'if-icon-btn',
    active && 'if-icon-btn--active',
    size === 'l' && 'if-icon-btn--l',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...rest}
    >
      <i className={`codicon codicon-${icon}`} aria-hidden="true" />
    </button>
  );
});
