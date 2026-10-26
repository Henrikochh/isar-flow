/** Small list editors: key/value pairs (environment variables) and single values (file patterns). */
import { Button, IconButton, TextInput } from '../../../components';
import { useFocusOnAdd } from './useFocusOnAdd';
import { useRowsDraft } from './useRowsDraft';

interface Pair {
  key: string;
  value: string;
}

const isBlankPair = (row: Pair) => row.key.trim() === '' && row.value === '';

function pairProblems(rows: Pair[]): (string | undefined)[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.key.trim(), (counts.get(row.key.trim()) ?? 0) + 1);
  return rows.map((row) => {
    if (isBlankPair(row)) return undefined;
    const key = row.key.trim();
    if (key === '') return 'Enter a name for this value.';
    if (/\s/.test(key)) return 'Names cannot contain spaces.';
    if ((counts.get(key) ?? 0) > 1) return `'${key}' is set twice.`;
    return undefined;
  });
}

export function KeyValueEditor({
  entries,
  onCommit,
  noun,
  addLabel,
}: {
  entries: [string, string][];
  onCommit: (entries: [string, string][]) => void;
  /** Used in accessible names, e.g. "variable". */
  noun: string;
  addLabel: string;
}) {
  const source = entries.map(([key, value]) => ({ key, value }));
  const draft = useRowsDraft<Pair>(
    source,
    (rows) => onCommit(rows.map((row) => [row.key.trim(), row.value])),
    { isBlank: isBlankPair, isValid: (rows) => pairProblems(rows).every((p) => p === undefined) },
  );
  const problems = pairProblems(draft.rows);
  const focus = useFocusOnAdd(draft.rows.length);
  return (
    <div className="wf-insp-rows" ref={focus.containerRef}>
      {draft.rows.map((row, index) => (
        <div key={index} className="wf-insp-pair" data-row>
          <div className="wf-insp-pair-line">
            <TextInput
              code
              aria-label={`Name of ${noun} ${index + 1}`}
              placeholder="NAME"
              value={row.key}
              invalid={Boolean(problems[index])}
              onChange={(event) => draft.update(index, { key: event.target.value })}
              onBlur={draft.flush}
            />
            <span className="wf-insp-pair-eq" aria-hidden="true">
              =
            </span>
            <TextInput
              code
              aria-label={`Value of ${noun} ${index + 1}`}
              placeholder="value"
              value={row.value}
              onChange={(event) => draft.update(index, { value: event.target.value })}
              onBlur={draft.flush}
            />
            <IconButton
              icon="trash"
              label={`Remove ${noun} ${row.key || index + 1}`}
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
        <Button
          size="s"
          variant="ghost"
          icon="add"
          onClick={() => {
            focus.markAdded();
            draft.add({ key: '', value: '' });
          }}
        >
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

interface Item {
  value: string;
}

export function ListEditor({
  values,
  onCommit,
  noun,
  addLabel,
  placeholder,
}: {
  values: string[];
  onCommit: (values: string[]) => void;
  noun: string;
  addLabel: string;
  placeholder?: string;
}) {
  const draft = useRowsDraft<Item>(
    values.map((value) => ({ value })),
    (rows) => onCommit(rows.map((row) => row.value.trim())),
    { isBlank: (row) => row.value.trim() === '' },
  );
  const focus = useFocusOnAdd(draft.rows.length);
  return (
    <div className="wf-insp-rows" ref={focus.containerRef}>
      {draft.rows.map((row, index) => (
        <div key={index} className="wf-insp-item" data-row>
          <TextInput
            code
            aria-label={`${noun} ${index + 1}`}
            placeholder={placeholder}
            value={row.value}
            onChange={(event) => draft.update(index, { value: event.target.value })}
            onBlur={draft.flush}
          />
          <IconButton
            icon="trash"
            label={`Remove ${noun} ${row.value || index + 1}`}
            onClick={() => draft.remove(index)}
          />
        </div>
      ))}
      <div>
        <Button
          size="s"
          variant="ghost"
          icon="add"
          onClick={() => {
            focus.markAdded();
            draft.add({ value: '' });
          }}
        >
          {addLabel}
        </Button>
      </div>
    </div>
  );
}
