import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { Spinner } from './Display';

export type ButtonVariant = 'primary' | 'run' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 's' | 'm';
  /** Codicon name, e.g. 'play'. */
  icon?: string;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'm', icon, loading, className, children, type = 'button', disabled, ...rest },
  ref,
) {
  const classes = ['if-btn', `if-btn--${variant}`, size === 's' && 'if-btn--s', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={classes} disabled={disabled || loading} {...rest}>
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
  const classes = ['if-icon-btn', active && 'if-icon-btn--active', size === 'l' && 'if-icon-btn--l', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={classes} aria-label={label} title={label} aria-pressed={active} {...rest}>
      <i className={`codicon codicon-${icon}`} aria-hidden="true" />
    </button>
  );
});
