import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  /** Right-aligned secondary text, e.g. a capability or scope. */
  meta?: ReactNode;
  /** Leading visual (icon, stone). */
  leading?: ReactNode;
  group?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T | undefined;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  /** Show a filter box (recommended for long lists like models). */
  searchable?: boolean;
  /** Allow choosing the typed text when it matches no option (e.g. an unlisted model ref). */
  allowCustom?: boolean;
  customLabel?: (text: string) => string;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  ariaLabel?: string;
  /** Rendered as the trigger content for the selected option; defaults to label. */
  renderValue?: (option: SelectOption<T> | undefined) => ReactNode;
  footer?: ReactNode;
  emptyText?: string;
}

/** Accessible listbox popover with groups, search, and keyboard navigation. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  searchable,
  allowCustom,
  customLabel = (text) => `Use "${text}"`,
  id,
  describedBy,
  invalid,
  ariaLabel,
  renderValue,
  footer,
  emptyText = 'Nothing matches',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<'down' | 'up'>('down');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Every typed word must appear somewhere in the option, so "tests exit" finds "tests › exitCode".
    const words = q.split(/\s+/).filter(Boolean);
    const list = q
      ? options.filter((o) => {
          const haystack = [o.label, o.description, o.value, o.group].filter(Boolean).join(' ').toLowerCase();
          return words.every((word) => haystack.includes(word));
        })
      : options;
    if (allowCustom && q && !options.some((o) => o.value.toLowerCase() === q)) {
      return [...list, { value: query.trim() as T, label: customLabel(query.trim()), group: undefined }];
    }
    return list;
  }, [options, query, allowCustom, customLabel]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPlacement(window.innerHeight - rect.bottom < 280 && rect.top > 300 ? 'up' : 'down');
    const index = filtered.findIndex((o) => o.value === value);
    setActive(index >= 0 ? index : 0);
    if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
    else requestAnimationFrame(() => listRef.current?.focus());
    // Runs only when the popover opens; filtered/value are read at that moment on purpose.
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (option: SelectOption<T> | undefined) => {
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  };

  const onListKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(filtered[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  let lastGroup: string | undefined;

  return (
    <div className={['if-select', open && 'if-select--open'].filter(Boolean).join(' ')} ref={rootRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="if-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {selected?.leading}
        <span className={['if-select__value', !selected && !value && 'if-select__placeholder'].filter(Boolean).join(' ')}>
          {renderValue ? renderValue(selected) : selected ? selected.label : value || placeholder}
        </span>
        <i className="codicon codicon-chevron-down if-select__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className={`if-select__popover if-select__popover--${placement}`}>
          {searchable ? (
            <input
              ref={searchRef}
              className="if-input if-select__search"
              placeholder="Filter…"
              value={query}
              role="combobox"
              aria-label="Filter options"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onListKeyDown}
            />
          ) : null}
          <div
            ref={listRef}
            id={listId}
            className="if-select__list"
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
            onKeyDown={onListKeyDown}
          >
            {filtered.length === 0 ? <div className="if-select__empty">{emptyText}</div> : null}
            {filtered.map((option, index) => {
              const header = option.group && option.group !== lastGroup ? option.group : undefined;
              lastGroup = option.group;
              return (
                <div key={`${option.group ?? ''}:${option.value}:${index}`}>
                  {header ? <div className="if-select__group">{header}</div> : null}
                  <div
                    id={`${listId}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled || undefined}
                    className={['if-select__option', index === active && 'if-select__option--active'].filter(Boolean).join(' ')}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(option)}
                  >
                    {option.leading}
                    <span className="if-select__option-text">
                      <span className="if-select__option-label">{option.label}</span>
                      {option.description ? <span className="if-select__option-desc">{option.description}</span> : null}
                    </span>
                    {option.meta ? <span className="if-select__option-meta">{option.meta}</span> : null}
                    {option.value === value ? <i className="codicon codicon-check" aria-hidden="true" /> : null}
                  </div>
                </div>
              );
            })}
          </div>
          {footer}
        </div>
      ) : null}
    </div>
  );
}
