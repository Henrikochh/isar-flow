/** Field building blocks of the inspector: draft-backed inputs and fields that show diagnostics. */
import { type InputHTMLAttributes, type ReactNode, useRef } from 'react';
import type { Diagnostic, VariableInfo } from '@isar-flow/core';
import { Field, TextArea, TextInput } from '../../../components';
import { useDraft } from '../../../hooks';
import { toTemplate } from './conditionModel';
import { TemplateTextArea } from './TemplateTextArea';
import { VariablePicker } from './VariablePicker';

/** Error and hint for a Field from local validation and the document's diagnostics. */
export function issueProps(
  issues: readonly Diagnostic[] | undefined,
  localError?: string,
  hint?: ReactNode,
): { error?: string; hint?: ReactNode } {
  const error = localError ?? issues?.find((d) => d.severity === 'error')?.message;
  if (error) return { error };
  const warnings = issues?.filter((d) => d.severity !== 'error') ?? [];
  if (warnings.length === 0) return { hint };
  return {
    hint: (
      <span className="wf-insp-warning">
        <i className="codicon codicon-warning wf-insp-warning-icon" aria-hidden="true" />
        <span>{warnings.map((w) => w.message).join(' ')}</span>
      </span>
    ),
  };
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'>;

export interface DraftInputProps extends InputProps {
  value: string;
  onCommit: (value: string) => void;
  code?: boolean;
  invalid?: boolean;
}

/** TextInput that keeps typing local and commits after a pause or on blur. */
export function DraftInput({ value, onCommit, onBlur, onKeyDown, ...rest }: DraftInputProps) {
  const draft = useDraft(value, onCommit);
  return (
    <TextInput
      {...rest}
      value={draft.value}
      onChange={(event) => draft.change(event.target.value)}
      onBlur={(event) => {
        draft.flush();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') draft.flush();
        onKeyDown?.(event);
      }}
    />
  );
}

export interface TextFieldProps {
  label: ReactNode;
  value: string;
  onCommit: (value: string) => void;
  /** Block whose variables the `{x}` picker offers; omit to hide the picker. */
  variablesFor?: string | null;
  multiline?: boolean;
  code?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  issues?: readonly Diagnostic[];
  error?: string;
  minRows?: number;
  maxRows?: number;
  labelExtra?: ReactNode;
  /** Live validation of the text being typed. */
  validate?: (text: string) => string | undefined;
  /** Insert picked variables as bare expressions (inside an expression) instead of `${{ }}` templates. */
  bareVariables?: boolean;
}

/** Labelled text input or auto-growing text area with an optional `{x}` variable picker. */
export function TextField({
  label,
  value,
  onCommit,
  variablesFor,
  multiline,
  code,
  placeholder,
  hint,
  issues,
  error,
  minRows = 3,
  maxRows = 16,
  labelExtra,
  validate,
  bareVariables,
}: TextFieldProps) {
  const draft = useDraft(value, onCommit);
  const localError = error ?? validate?.(draft.value);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const withPicker = variablesFor !== undefined;
  const Area = withPicker ? TemplateTextArea : TextArea;

  const remember = (el: HTMLInputElement | HTMLTextAreaElement) => {
    selection.current = { start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
  };

  const insert = (variable: VariableInfo) => {
    const token = bareVariables ? variable.expression : toTemplate(variable.expression);
    const text = draft.value;
    const { start, end } = selection.current ?? { start: text.length, end: text.length };
    const next = text.slice(0, start) + token + text.slice(end);
    const caret = start + token.length;
    selection.current = { start: caret, end: caret };
    draft.change(next);
    requestAnimationFrame(() => {
      const el = multiline ? areaRef.current : inputRef.current;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className={withPicker ? 'wf-insp-picker-field' : undefined}>
      <Field label={label} labelExtra={labelExtra} {...issueProps(issues, localError, hint)}>
        {({ id, describedBy, invalid }) =>
          multiline ? (
            <Area
              ref={areaRef}
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              code={code}
              autoGrow
              minRows={minRows}
              maxRows={maxRows}
              placeholder={placeholder}
              value={draft.value}
              onChange={(event) => draft.change(event.target.value)}
              onBlur={(event) => {
                remember(event.currentTarget);
                draft.flush();
              }}
            />
          ) : (
            <TextInput
              ref={inputRef}
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              code={code}
              placeholder={placeholder}
              value={draft.value}
              onChange={(event) => draft.change(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') draft.flush();
              }}
              onBlur={(event) => {
                remember(event.currentTarget);
                draft.flush();
              }}
            />
          )
        }
      </Field>
      {withPicker ? (
        <div className="wf-insp-picker-slot">
          <VariablePicker stepId={variablesFor ?? null} onPick={insert} />
        </div>
      ) : null}
    </div>
  );
}

export interface NumberFieldProps {
  label: ReactNode;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  /** Clearing the field is an error instead of removing the value. */
  required?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  issues?: readonly Diagnostic[];
  suffix?: string;
}

/** Number input that validates range locally and commits `undefined` when cleared. */
export function NumberField({ label, value, onCommit, min, max, integer, required, placeholder, hint, issues, suffix }: NumberFieldProps) {
  const text = value === undefined ? '' : String(value);
  const problem = (raw: string): string | undefined => {
    const range = min !== undefined && max !== undefined ? ` from ${min} to ${max}` : '';
    if (raw.trim() === '') return required ? `Enter a number${range}.` : undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (integer && !Number.isInteger(n)) return 'Enter a whole number.';
    if (min !== undefined && n < min) return max !== undefined ? `Use a value from ${min} to ${max}.` : `Use ${min} or more.`;
    if (max !== undefined && n > max) return min !== undefined ? `Use a value from ${min} to ${max}.` : `Use ${max} or less.`;
    return undefined;
  };
  const draft = useDraft(text, (raw) => {
    if (problem(raw)) return;
    onCommit(raw.trim() === '' ? undefined : Number(raw));
  });
  return (
    <Field label={label} {...issueProps(issues, problem(draft.value), hint)}>
      {({ id, describedBy, invalid }) => (
        <div className="wf-insp-number">
          <TextInput
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            className="wf-insp-number-input"
            inputMode="decimal"
            placeholder={placeholder}
            value={draft.value}
            onChange={(event) => draft.change(event.target.value)}
            onBlur={draft.flush}
            onKeyDown={(event) => {
              if (event.key === 'Enter') draft.flush();
            }}
          />
          {suffix ? <span className="wf-insp-number-suffix">{suffix}</span> : null}
        </div>
      )}
    </Field>
  );
}
