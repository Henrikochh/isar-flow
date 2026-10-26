import { type KeyboardEvent, type ReactNode, useRef } from 'react';

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="if-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="if-switch__track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="if-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="if-check__box" aria-hidden="true">
        <i className="codicon codicon-check" />
      </span>
      <span className="if-check__text">
        <span>{label}</span>
        {description ? <span className="if-check__desc">{description}</span> : null}
      </span>
    </label>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: string;
  count?: number;
  title?: string;
}

/** Single-choice control (radiogroup) with arrow-key navigation. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  full,
  role = 'radiogroup',
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  full?: boolean;
  /** Use 'tablist' when the control switches panels. */
  role?: 'radiogroup' | 'tablist';
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  const itemRole = role === 'tablist' ? 'tab' : 'radio';
  return (
    <div
      className={['if-segmented', full && 'if-segmented--full'].filter(Boolean).join(' ')}
      role={role}
      aria-label={label}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role={itemRole}
            className="if-segmented__item"
            aria-checked={itemRole === 'radio' ? selected : undefined}
            aria-selected={itemRole === 'tab' ? selected : undefined}
            tabIndex={selected ? 0 : -1}
            title={option.title}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {option.icon ? <i className={`codicon codicon-${option.icon}`} aria-hidden="true" /> : null}
            <span>{option.label}</span>
            {option.count !== undefined ? <span className="if-segmented__count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
