import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { VariableInfo } from '@isar-flow/core';
import { Button, Stone } from '../../../components';
import { Popover } from '../../../components/Popover';
import { GROUP_LABELS, TYPE_LABELS, useVariables, variableKey, variableLabel } from './variables';

export interface VariablePickerProps {
  /** Block the variable is used in (null = workflow level); decides which outputs are readable. */
  stepId: string | null;
  onPick: (variable: VariableInfo) => void;
}

/** The `{x}` button: a searchable, grouped list of variables available at this block. */
export function VariablePicker({ stepId, onPick }: VariablePickerProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchorRef}
        size="s"
        variant="ghost"
        className="wf-insp-var-trigger"
        aria-label="Insert variable"
        title="Insert variable"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="wf-insp-var-glyph">{'{x}'}</span>
      </Button>
      <Popover
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        label="Insert variable"
        width={320}
        className="wf-insp-var-popover"
      >
        <VariableList
          stepId={stepId}
          onPick={(variable) => {
            setOpen(false);
            onPick(variable);
          }}
        />
      </Popover>
    </>
  );
}

function matches(variable: VariableInfo, query: string): boolean {
  if (!query) return true;
  const haystack = `${variableLabel(variable)} ${variable.expression} ${variable.description}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

export function VariableList({ stepId, onPick }: VariablePickerProps) {
  const { variables, blockTypes } = useVariables(stepId);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filtered = useMemo(() => variables.filter((v) => matches(v, query.trim())), [variables, query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const variable = filtered[active];
      if (variable) onPick(variable);
    }
  };

  const rows: ReactNode[] = [];
  let lastHeader = '';
  filtered.forEach((variable, index) => {
    const header = variable.group === 'steps' ? `steps:${variable.stepId}` : variable.group;
    if (header !== lastHeader) {
      lastHeader = header;
      const type = variable.stepId ? blockTypes.get(variable.stepId) : undefined;
      rows.push(
        <div key={`h:${header}`} className="if-select__group" role="presentation">
          {variable.group === 'steps' ? (
            <>
              {type ? <Stone type={type} size="s" /> : null}
              <span className="wf-insp-var-block">{variable.stepId}</span>
            </>
          ) : (
            GROUP_LABELS[variable.group]
          )}
        </div>,
      );
    }
    rows.push(
      <div
        key={variable.expression}
        id={`${listId}-${index}`}
        data-index={index}
        role="option"
        aria-selected={index === active}
        className={['if-select__option', index === active && 'if-select__option--active'].filter(Boolean).join(' ')}
        onMouseEnter={() => setActive(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onPick(variable)}
      >
        <span className="if-select__option-text">
          <span className="if-select__option-label wf-insp-var-label">
            {variable.group === 'steps' ? variableKey(variable) : variable.label}
          </span>
          <span className="if-select__option-desc">{variable.description}</span>
        </span>
        <span className="if-select__option-meta">{TYPE_LABELS[variable.type]}</span>
      </div>,
    );
  });

  return (
    <>
      <input
        className="if-input if-select__search"
        placeholder="Search variables"
        aria-label="Search variables"
        aria-controls={listId}
        aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        data-autofocus
      />
      <div ref={listRef} id={listId} className="if-select__list wf-insp-var-list" role="listbox" aria-label="Variables">
        {rows.length ? rows : <div className="if-select__empty">No variables match "{query.trim()}".</div>}
      </div>
    </>
  );
}
