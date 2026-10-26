import { type FormEvent, useState } from 'react';
import type { WorkflowInput } from '@isar-flow/core';
import { Button, Dialog, Field, Switch, TextArea, TextInput } from '../../../components';
import { patchEditorState, readEditorState } from '../viewState';

type Value = string | boolean;

/** Declared workflow inputs, tolerating malformed YAML. */
export function declaredInputs(inputs: unknown): [string, WorkflowInput][] {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) return [];
  return Object.entries(inputs as Record<string, unknown>).map(([name, def]) => [
    name,
    typeof def === 'object' && def !== null && !Array.isArray(def) ? (def as WorkflowInput) : {},
  ]);
}

function initialValue(def: WorkflowInput, remembered: unknown): Value {
  if (def.type === 'boolean') return typeof remembered === 'boolean' ? remembered : def.default === true;
  if (typeof remembered === 'string' || typeof remembered === 'number') return String(remembered);
  return def.default === undefined ? '' : String(def.default);
}

function toRunValue(def: WorkflowInput, value: Value): unknown {
  if (def.type === 'boolean') return value === true;
  if (def.type === 'number') return value === '' ? undefined : Number(value);
  return value;
}

/** "Run <name>" dialog asking for the workflow inputs; values are remembered per workflow. */
export function InputsDialog({
  workflowName,
  uri,
  inputs,
  onRun,
  onClose,
}: {
  workflowName: string;
  uri: string;
  inputs: [string, WorkflowInput][];
  onRun: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, Value>>(() => {
    const remembered = readEditorState().runInputs?.[uri] ?? {};
    return Object.fromEntries(inputs.map(([name, def]) => [name, initialValue(def, remembered[name])]));
  });
  const set = (name: string, value: Value) => setValues((v) => ({ ...v, [name]: value }));
  const missing = inputs.filter(
    ([name, def]) => def.required && def.type !== 'boolean' && String(values[name] ?? '').trim() === '',
  );
  const badNumber = inputs.filter(
    ([name, def]) => def.type === 'number' && values[name] !== '' && Number.isNaN(Number(values[name])),
  );

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (missing.length || badNumber.length) return;
    const runInputs = { ...(readEditorState().runInputs ?? {}), [uri]: values };
    patchEditorState({ runInputs });
    const result: Record<string, unknown> = {};
    for (const [name, def] of inputs) {
      const value = toRunValue(def, values[name] ?? '');
      if (value !== undefined) result[name] = value;
    }
    onRun(result);
  };

  return (
    <Dialog
      title={`Run ${workflowName}`}
      icon={
        <span className="wf-dialog-dot" aria-hidden="true">
          <i className="codicon codicon-play" />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="run"
            icon="play"
            disabled={missing.length > 0 || badNumber.length > 0}
            onClick={() => submit()}
          >
            Run workflow
          </Button>
        </>
      }
    >
      <form className="wf-inputs-form" onSubmit={submit}>
        {inputs.map(([name, def]) => {
          const value = values[name];
          const error = badNumber.some(([n]) => n === name) ? 'Enter a number.' : undefined;
          if (def.type === 'boolean') {
            return (
              <div key={name} className="wf-inputs-form__switch">
                <Switch
                  checked={value === true}
                  onChange={(checked) => set(name, checked)}
                  label={<code>{name}</code>}
                />
                {def.description ? <span className="if-field__hint">{def.description}</span> : null}
              </div>
            );
          }
          return (
            <Field
              key={name}
              label={<code className="wf-input-name">{name}</code>}
              labelExtra={def.required ? 'Required' : 'Optional'}
              hint={def.description}
              error={error}
            >
              {({ id, describedBy, invalid }) =>
                def.multiline ? (
                  <TextArea
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    autoGrow
                    minRows={3}
                    maxRows={12}
                    value={String(value ?? '')}
                    onChange={(e) => set(name, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
                    }}
                  />
                ) : (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    inputMode={def.type === 'number' ? 'decimal' : undefined}
                    value={String(value ?? '')}
                    onChange={(e) => set(name, e.target.value)}
                  />
                )
              }
            </Field>
          );
        })}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
