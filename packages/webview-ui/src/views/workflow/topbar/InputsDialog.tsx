import { type FormEvent, useState } from 'react';
import type { WorkflowInput } from '@isar-flow/core';
import { Banner, Button, Dialog, Field, Switch, TextArea, TextInput } from '../../../components';
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

export type InputsDialogMode = 'run' | 'simulate' | 'resume';

/** A simulation confirms in the simulation tone: it must never look like a real run. */
const MODES: Record<
  InputsDialogMode,
  { icon: string; button: string; variant: 'run' | 'simulate'; remember: boolean }
> = {
  run: { icon: 'play', button: 'Run workflow', variant: 'run', remember: true },
  simulate: { icon: 'beaker', button: 'Simulate', variant: 'simulate', remember: true },
  resume: { icon: 'run-below', button: 'Run from here', variant: 'run', remember: false },
};

/**
 * Asks for the workflow inputs before a run ("Run <name>"), a simulation ("Simulate <name>") or a run that continues
 * a past one at a block ("Run from <block>"). Runs and simulations share the values remembered per workflow; a
 * resumed run starts from the inputs of the run it continues and leaves the remembered values alone.
 */
export function InputsDialog({
  mode = 'run',
  workflowName,
  blockName,
  uri,
  inputs,
  values: given,
  notes,
  blocker,
  onRun,
  onClose,
}: {
  mode?: InputsDialogMode;
  workflowName: string;
  /** resume: the block the run starts at. */
  blockName?: string;
  uri: string;
  inputs: [string, WorkflowInput][];
  /** Starting values instead of the remembered ones (resume: the inputs of the run it continues). */
  values?: Record<string, unknown>;
  /** resume: quiet lines and things to check before running. */
  notes?: { info: string[]; warnings: string[] };
  /** Why the run can't start; shown as an error, and the button stays disabled. */
  blocker?: string;
  onRun: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const config = MODES[mode];
  const [values, setValues] = useState<Record<string, Value>>(() => {
    const start = given ?? readEditorState().runInputs?.[uri] ?? {};
    return Object.fromEntries(inputs.map(([name, def]) => [name, initialValue(def, start[name])]));
  });
  const set = (name: string, value: Value) => setValues((v) => ({ ...v, [name]: value }));
  const missing = inputs.filter(
    ([name, def]) => def.required && def.type !== 'boolean' && String(values[name] ?? '').trim() === '',
  );
  const badNumber = inputs.filter(
    ([name, def]) => def.type === 'number' && values[name] !== '' && Number.isNaN(Number(values[name])),
  );

  const blocked = blocker !== undefined || missing.length > 0 || badNumber.length > 0;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (blocked) return;
    if (config.remember) {
      const runInputs = { ...(readEditorState().runInputs ?? {}), [uri]: values };
      patchEditorState({ runInputs });
    }
    const result: Record<string, unknown> = {};
    for (const [name, def] of inputs) {
      const value = toRunValue(def, values[name] ?? '');
      if (value !== undefined) result[name] = value;
    }
    onRun(result);
  };

  const title =
    mode === 'resume'
      ? `Run from ${blockName ?? 'here'}`
      : mode === 'simulate'
        ? `Simulate ${workflowName}`
        : `Run ${workflowName}`;

  return (
    <Dialog
      title={title}
      icon={
        <span
          className={mode === 'simulate' ? 'wf-dialog-dot wf-dialog-dot--simulate' : 'wf-dialog-dot'}
          aria-hidden="true"
        >
          {/* The play glyph sits optically left of center; the others don't. */}
          <i
            className={`codicon codicon-${config.icon}`}
            style={mode === 'run' ? undefined : { marginLeft: 0 }}
          />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={config.variant} icon={config.icon} disabled={blocked} onClick={() => submit()}>
            {config.button}
          </Button>
        </>
      }
    >
      {mode === 'simulate' ? (
        <p className="wf-dialog-note">
          Nothing runs: commands, agents and approvals use the mocks of the simulation file.
        </p>
      ) : null}
      {blocker ? <Banner tone="error">{blocker}</Banner> : null}
      {notes?.info.length ? (
        <div className="wf-dialog-notes">
          {notes.info.map((line) => (
            <p key={line} className="wf-dialog-note">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {notes?.warnings.length ? (
        <Banner tone="warning" title="Check before running">
          <ul className="wf-dialog-warnings">
            {notes.warnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {inputs.length ? (
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
      ) : null}
    </Dialog>
  );
}
