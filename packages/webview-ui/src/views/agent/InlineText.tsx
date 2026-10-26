import { useRef } from 'react';
import { useDraft } from '../../hooks';

export interface InlineTextProps {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder?: string;
  className: string;
  /** Empty text is never committed; leaving the field empty restores the previous value. */
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * Text that reads like a heading and edits in place. Commits like every form field (idle and blur);
 * Enter finishes, Escape restores the value from before editing started.
 */
export function InlineText({ value, onCommit, label, placeholder, className, required, invalid, describedBy }: InlineTextProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committed = useRef(value);
  const draft = useDraft(value, (next) => {
    if (next === committed.current || (required && !next.trim())) return;
    committed.current = next;
    onCommit(next);
  });
  const original = useRef(value);

  const restore = () => {
    draft.change(original.current);
    draft.flush();
  };

  return (
    <input
      ref={inputRef}
      className={className}
      value={draft.value}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      spellCheck={false}
      onFocus={() => {
        original.current = value;
        committed.current = value;
      }}
      onChange={(event) => draft.change(event.target.value)}
      onBlur={() => {
        if (required && !draft.value.trim()) restore();
        else draft.flush();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          inputRef.current?.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          restore();
          inputRef.current?.blur();
        }
      }}
    />
  );
}
