import {
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  forwardRef,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';

export interface FieldProps {
  label: ReactNode;
  /** Shown right-aligned next to the label (e.g. "Optional"). */
  labelExtra?: ReactNode;
  hint?: ReactNode;
  error?: string;
  /** Render prop receives the generated control id and aria-describedby ids. */
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  className?: string;
}

/** Label + control + hint/error, wired for accessibility. */
export function Field({ label, labelExtra, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={['if-field', className].filter(Boolean).join(' ')}>
      <label className="if-field__label" htmlFor={id}>
        <span>{label}</span>
        {labelExtra ? <span className="if-field__label-extra">{labelExtra}</span> : null}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <div className="if-field__error" id={errorId}>
          <i className="codicon codicon-error" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : hint ? (
        <div className="if-field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  code?: boolean;
  invalid?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { code, invalid, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={['if-input', code && 'if-input--code', className].filter(Boolean).join(' ')}
      aria-invalid={invalid || undefined}
      spellCheck={code ? false : undefined}
      {...rest}
    />
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  code?: boolean;
  invalid?: boolean;
  /** Grow with content between minRows and maxRows. */
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { code, invalid, autoGrow, minRows = 3, maxRows = 18, className, value, ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!autoGrow || !el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = 'auto';
    const padding = 16;
    const min = minRows * lineHeight + padding;
    const max = maxRows * lineHeight + padding;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight + 2))}px`;
  }, [value, autoGrow, minRows, maxRows]);

  return (
    <textarea
      ref={(el) => {
        innerRef.current = el;
        if (typeof forwardedRef === 'function') forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
      className={['if-textarea', code && 'if-textarea--code', className].filter(Boolean).join(' ')}
      aria-invalid={invalid || undefined}
      spellCheck={code ? false : undefined}
      rows={minRows}
      value={value}
      {...rest}
    />
  );
});
