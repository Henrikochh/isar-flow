import { STEP_ID_PATTERN } from '@isar-flow/core';
import { Button, Checkbox, IconButton, Select, type SelectOption, TextInput } from '../../../../components';
import { asString, isRecord } from '../model';
import { useFocusOnAdd } from '../useFocusOnAdd';
import { useRowsDraft } from '../useRowsDraft';

type InputType = 'string' | 'number' | 'boolean';

export interface InputRow {
  name: string;
  type: InputType;
  description: string;
  /** Default as typed; parsed by type on commit. */
  defaultText: string;
  required: boolean;
  multiline: boolean;
  /** The input's original mapping, so key order and unknown keys survive edits. */
  original: Record<string, unknown>;
}

const TYPES: SelectOption<InputType>[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes/no' },
];

const BOOLEAN_DEFAULTS: SelectOption[] = [
  { value: '', label: 'No default' },
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

export function inputRows(inputs: unknown): InputRow[] {
  if (!isRecord(inputs)) return [];
  return Object.entries(inputs).map(([name, raw]) => {
    const input = isRecord(raw) ? raw : {};
    const type: InputType = input.type === 'number' || input.type === 'boolean' ? input.type : 'string';
    return {
      name,
      type,
      description: asString(input.description),
      defaultText: input.default === undefined ? '' : asString(input.default),
      required: input.required === true,
      multiline: input.multiline === true,
      original: input,
    };
  });
}

const isBlank = (row: InputRow) =>
  row.name.trim() === '' && row.description.trim() === '' && row.defaultText.trim() === '';

function defaultProblem(row: InputRow): string | undefined {
  const text = row.defaultText.trim();
  if (text === '' || row.type !== 'number') return undefined;
  return Number.isFinite(Number(text)) ? undefined : 'The default must be a number.';
}

export function inputProblems(rows: InputRow[]): (string | undefined)[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.name.trim(), (counts.get(row.name.trim()) ?? 0) + 1);
  return rows.map((row) => {
    if (isBlank(row)) return undefined;
    const name = row.name.trim();
    if (name === '') return 'Enter a name. Blocks read the value as inputs.<name>.';
    if (!STEP_ID_PATTERN.test(name))
      return 'Names start with a letter or _ and use only letters, digits, _ and -.';
    if ((counts.get(name) ?? 0) > 1) return `There are two inputs named '${name}'.`;
    return defaultProblem(row);
  });
}

/** The YAML mapping for an input row, keeping the original key order. */
export function inputValue(row: InputRow): Record<string, unknown> {
  const text = row.defaultText.trim();
  const fallback =
    text === ''
      ? undefined
      : row.type === 'number'
        ? Number(text)
        : row.type === 'boolean'
          ? text === 'true'
          : row.defaultText;
  const values: Record<string, unknown> = {
    type: row.type,
    description: row.description.trim() || undefined,
    default: fallback,
    required: row.required || undefined,
    multiline: (row.type === 'string' && row.multiline) || undefined,
  };
  const out: Record<string, unknown> = {};
  for (const key of [...Object.keys(row.original), ...Object.keys(values)]) {
    if (key in out) continue;
    const value = key in values ? values[key] : row.original[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function InputsEditor({
  inputs,
  onCommit,
}: {
  inputs: unknown;
  onCommit: (inputs: Record<string, unknown> | undefined) => void;
}) {
  const draft = useRowsDraft<InputRow>(
    inputRows(inputs),
    (rows) =>
      onCommit(
        rows.length ? Object.fromEntries(rows.map((row) => [row.name.trim(), inputValue(row)])) : undefined,
      ),
    { isBlank, isValid: (rows) => inputProblems(rows).every((p) => p === undefined) },
  );
  const focus = useFocusOnAdd(draft.rows.length);
  const problems = inputProblems(draft.rows);

  return (
    <div className="wf-insp-rows" ref={focus.containerRef}>
      {draft.rows.map((row, index) => {
        const label = row.name.trim() || `input ${index + 1}`;
        return (
          <div key={index} className="wf-insp-card" data-row>
            <div className="wf-insp-card-line">
              <TextInput
                code
                aria-label={`Name of input ${index + 1}`}
                placeholder="name"
                value={row.name}
                invalid={Boolean(problems[index]) && !defaultProblem(row)}
                onChange={(event) => draft.update(index, { name: event.target.value })}
                onBlur={draft.flush}
              />
              <div className="wf-insp-card-type">
                <Select<InputType>
                  ariaLabel={`Type of ${label}`}
                  value={row.type}
                  options={TYPES}
                  onChange={(type) =>
                    draft.update(
                      index,
                      { type, defaultText: type === row.type ? row.defaultText : '' },
                      'now',
                    )
                  }
                />
              </div>
              <IconButton icon="trash" label={`Remove ${label}`} onClick={() => draft.remove(index)} />
            </div>
            <TextInput
              aria-label={`Description of ${label}`}
              placeholder="Description shown when the run starts"
              value={row.description}
              onChange={(event) => draft.update(index, { description: event.target.value })}
              onBlur={draft.flush}
            />
            {row.type === 'boolean' ? (
              <Select
                ariaLabel={`Default of ${label}`}
                value={row.defaultText}
                options={BOOLEAN_DEFAULTS}
                onChange={(defaultText) => draft.update(index, { defaultText }, 'now')}
              />
            ) : (
              <TextInput
                aria-label={`Default of ${label}`}
                placeholder="Default value"
                code={row.type === 'number'}
                invalid={Boolean(defaultProblem(row))}
                value={row.defaultText}
                onChange={(event) => draft.update(index, { defaultText: event.target.value })}
                onBlur={draft.flush}
              />
            )}
            <div className="wf-insp-card-checks">
              <Checkbox
                checked={row.required}
                label="Required"
                onChange={(required) => draft.update(index, { required }, 'now')}
              />
              {row.type === 'string' ? (
                <Checkbox
                  checked={row.multiline}
                  label="Multi-line"
                  onChange={(multiline) => draft.update(index, { multiline }, 'now')}
                />
              ) : null}
            </div>
            {problems[index] ? (
              <div className="if-field__error">
                <i className="codicon codicon-error" aria-hidden="true" />
                <span>{problems[index]}</span>
              </div>
            ) : null}
          </div>
        );
      })}
      <div>
        <Button
          size="s"
          variant="ghost"
          icon="add"
          onClick={() => {
            focus.markAdded();
            draft.add({
              name: '',
              type: 'string',
              description: '',
              defaultText: '',
              required: false,
              multiline: false,
              original: {},
            });
          }}
        >
          Add input
        </Button>
      </div>
    </div>
  );
}
