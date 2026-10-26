import { describeOutputShape, type Diagnostic, type OutputShape } from '@isar-flow/core';
import { Banner, Button, Checkbox, IconButton, Select, type SelectOption, TextInput } from '../../../../components';
import { FieldIssues } from '../Issues';
import { FIELD_KINDS, type FieldKind, describeSpec, rowProblems, rowsToShape, type ShapeRow, shapeToRows, withKind } from '../shapeRows';
import { useFocusOnAdd } from '../useFocusOnAdd';
import { useRowsDraft } from '../useRowsDraft';

type KindValue = FieldKind | 'custom';

const isBlankRow = (row: ShapeRow) => row.key.trim() === '';

export interface JsonFieldsEditorProps {
  schema: unknown;
  onCommit: (shape: Record<string, unknown>) => void;
  onShowYaml: () => void;
  issues?: readonly Diagnostic[];
}

/** Rows editor for the compact JSON answer shape; full JSON Schemas are shown read-only. */
export function JsonFieldsEditor({ schema, onCommit, onShowYaml, issues }: JsonFieldsEditorProps) {
  const rows = shapeToRows(schema);
  if (rows === null) {
    return (
      <div className="wf-insp-stack">
        <pre className="wf-insp-code">{describeOutputShape(schema as OutputShape)}</pre>
        <Banner
          tone="info"
          title="This answer format is a JSON Schema. Edit it in YAML."
          actions={
            <Button size="s" variant="secondary" icon="go-to-file" onClick={onShowYaml}>
              Show in YAML
            </Button>
          }
        />
        <FieldIssues issues={issues} />
      </div>
    );
  }
  return <ShapeRowsEditor rows={rows} onCommit={onCommit} issues={issues} />;
}

function ShapeRowsEditor({
  rows: source,
  onCommit,
  issues,
}: {
  rows: ShapeRow[];
  onCommit: (shape: Record<string, unknown>) => void;
  issues?: readonly Diagnostic[];
}) {
  const draft = useRowsDraft<ShapeRow>(source, (rows) => onCommit(rowsToShape(rows.map((r) => ({ ...r, key: r.key.trim() })))), {
    isBlank: isBlankRow,
    isValid: (rows) => rowProblems(rows.filter((r) => !isBlankRow(r))).every((p) => p === undefined),
  });
  const focus = useFocusOnAdd(draft.rows.length);
  const complete = draft.rows.filter((r) => !isBlankRow(r));
  const problems = rowProblems(complete);
  const problemOf = (row: ShapeRow) => (isBlankRow(row) ? undefined : problems[complete.indexOf(row)]);

  return (
    <div className="wf-insp-rows" ref={focus.containerRef}>
      {draft.rows.length ? (
        <div className="wf-insp-shape-head" aria-hidden="true">
          <span>Field</span>
          <span>Type</span>
          <span className="wf-insp-shape-center">Optional</span>
        </div>
      ) : (
        <p className="wf-insp-note">No fields yet. The answer can be any JSON value.</p>
      )}
      {draft.rows.map((row, index) => {
        const options: SelectOption<KindValue>[] = FIELD_KINDS.map((k) => ({ value: k.value, label: k.label }));
        if (row.kind === 'custom') options.push({ value: 'custom', label: describeSpec(row.spec), description: 'Kept as written in the YAML' });
        const problem = problemOf(row);
        const name = row.key.trim() || `field ${index + 1}`;
        return (
          <div key={index} className="wf-insp-shape-row" data-row>
            <div className="wf-insp-shape-line">
              <TextInput
                code
                aria-label={`Name of field ${index + 1}`}
                placeholder="name"
                value={row.key}
                invalid={Boolean(problem)}
                onChange={(event) => draft.update(index, { key: event.target.value })}
                onBlur={draft.flush}
              />
              <Select<KindValue>
                ariaLabel={`Type of ${name}`}
                value={row.kind}
                options={options}
                onChange={(kind) => {
                  if (kind !== 'custom') draft.replace(index, withKind(row, kind));
                }}
              />
              <span className="wf-insp-shape-check">
                <Checkbox
                  checked={row.optional}
                  label={<span className="if-visually-hidden">{`${name} is optional`}</span>}
                  onChange={(optional) => draft.update(index, { optional }, 'now')}
                />
              </span>
              <IconButton icon="trash" label={`Remove ${name}`} onClick={() => draft.remove(index)} />
            </div>
            {problem ? (
              <div className="if-field__error">
                <i className="codicon codicon-error" aria-hidden="true" />
                <span>{problem}</span>
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
            draft.add({ key: '', kind: 'string', optional: false, spec: 'string' });
          }}
        >
          Add field
        </Button>
      </div>
      <FieldIssues issues={issues} />
    </div>
  );
}
