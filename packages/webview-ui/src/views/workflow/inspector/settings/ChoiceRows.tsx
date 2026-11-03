/** Choice rows of an ask block: add, remove, and reorder with Alt+Up / Alt+Down. */
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { Button, IconButton, TextInput } from '../../../../components';
import { useFocusOnAdd } from '../useFocusOnAdd';
import { useRowsDraft } from '../useRowsDraft';
import { choiceProblems } from './askModel';

interface Item {
  value: string;
}

export function ChoiceRows({
  choices,
  startBlank,
  onCommit,
}: {
  choices: string[];
  /** Start with one empty, focused row (the question just turned from free text into choices). */
  startBlank?: boolean;
  onCommit: (choices: string[]) => void;
}) {
  const draft = useRowsDraft<Item>(
    choices.map((value) => ({ value })),
    (rows) => onCommit(rows.map((row) => row.value.trim())),
    {
      isBlank: (row) => row.value.trim() === '',
      isValid: (rows) => choiceProblems(rows.map((row) => row.value)).every((p) => p === undefined),
    },
  );
  const problems = choiceProblems(draft.rows.map((row) => row.value));
  const focus = useFocusOnAdd(draft.rows.length);
  const movedTo = useRef<number | null>(null);

  const addRow = () => {
    focus.markAdded();
    draft.add({ value: '' });
  };

  useEffect(() => {
    if (startBlank && draft.rows.length === 0) addRow();
    // Only when the rows first appear.
  }, []);

  useEffect(() => {
    const index = movedTo.current;
    movedTo.current = null;
    if (index === null) return;
    const rows = focus.containerRef.current?.querySelectorAll<HTMLElement>('[data-row]');
    rows?.[index]?.querySelector('input')?.focus();
  }, [draft.rows]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    if (draft.move(index, delta)) movedTo.current = index + delta;
  };

  return (
    <div className="wf-insp-rows" ref={focus.containerRef}>
      {draft.rows.map((row, index) => (
        <div key={index} className="wf-insp-pair" data-row>
          <div className="wf-insp-item">
            <TextInput
              aria-label={`Choice ${index + 1}`}
              placeholder={index === 0 ? 'e.g. staging' : undefined}
              value={row.value}
              invalid={Boolean(problems[index])}
              onChange={(event) => draft.update(index, { value: event.target.value })}
              onBlur={draft.flush}
              onKeyDown={(event) => onKeyDown(event, index)}
            />
            <IconButton
              icon="trash"
              label={`Remove choice ${row.value.trim() || index + 1}`}
              onClick={() => draft.remove(index)}
            />
          </div>
          {problems[index] ? (
            <div className="if-field__error">
              <i className="codicon codicon-error" aria-hidden="true" />
              <span>{problems[index]}</span>
            </div>
          ) : null}
        </div>
      ))}
      <div>
        <Button size="s" variant="ghost" icon="add" onClick={addRow}>
          Add choice
        </Button>
      </div>
    </div>
  );
}
