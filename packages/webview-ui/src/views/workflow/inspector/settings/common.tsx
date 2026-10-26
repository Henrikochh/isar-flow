import { type ReactNode, useCallback, useId, useState } from 'react';
import type { BlockNode, Diagnostic, WorkflowOp } from '@isar-flow/core';
import { Chip, Switch } from '../../../../components';
import { useWorkflowActions } from '../../store';
import { NumberField } from '../fields';
import { FieldIssues } from '../Issues';
import { asNumber, isRecord } from '../model';

export type StepPatch = (set: Record<string, unknown>, unset?: string[]) => void;

export interface SettingsProps {
  block: BlockNode;
  /** The block's YAML mapping (lenient: any field may be missing or mistyped). */
  step: Record<string, unknown>;
  stepId: string;
  update: StepPatch;
  issues: Map<string, Diagnostic[]>;
}

/** Sends `updateStep` for a block. */
export function useStepUpdate(stepId: string): StepPatch {
  const actions = useWorkflowActions();
  return useCallback(
    (set, unset = []) => {
      const op: WorkflowOp = { op: 'updateStep', stepId, set, ...(unset.length ? { unset } : {}) };
      actions.applyOps([op]);
    },
    [actions, stepId],
  );
}

/** Sets `key`, or removes it when the value is empty. */
export function setOrUnset(update: StepPatch, key: string, value: unknown): void {
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) update({}, [key]);
  else update({ [key]: value });
}

/** Label + control for controls that are not text inputs (segmented controls, switches, lists). */
export function Group({
  label,
  description,
  hint,
  issues,
  children,
  extra,
}: {
  label: ReactNode;
  /** Muted text between the label and the control. */
  description?: ReactNode;
  hint?: ReactNode;
  issues?: readonly Diagnostic[];
  children: ReactNode;
  /** Right-aligned content in the label row. */
  extra?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="if-field" role="group" aria-labelledby={id}>
      <div className="if-field__label">
        <span id={id}>{label}</span>
        {extra ? <span className="if-field__label-extra">{extra}</span> : null}
      </div>
      {description ? <div className="wf-insp-desc">{description}</div> : null}
      {children}
      {hint ? <div className="if-field__hint wf-insp-switch-hint">{hint}</div> : null}
      <FieldIssues issues={issues} />
    </div>
  );
}

/** Collapsible group; while closed, `summary` shows the values that differ from the defaults. */
export function Disclosure({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div className="wf-insp-disclosure">
      <button
        type="button"
        className="wf-insp-disclosure-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <i className={`codicon codicon-chevron-${open ? 'down' : 'right'} wf-insp-chevron`} aria-hidden="true" />
        <span className="wf-insp-disclosure-title">{title}</span>
        {!open && summary ? <span className="wf-insp-disclosure-summary">{summary}</span> : null}
      </button>
      {open ? (
        <div className="wf-insp-disclosure-body" id={bodyId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

const ADVANCED_KEYS = ['timeout', 'retry', 'continueOnError'];

/** Advanced group shared by agent and console blocks: timeout, retries and (optionally) continue on error. */
export function AdvancedSettings({ step, update, issues, withContinueOnError }: SettingsProps & { withContinueOnError: boolean }) {
  const timeout = asNumber(step.timeout);
  const retry = isRecord(step.retry) ? step.retry : undefined;
  const retries = asNumber(retry?.max);
  const continueOnError = step.continueOnError === true;
  const chips = [
    timeout !== undefined ? <Chip key="t" tone="outline">{`Timeout ${timeout} s`}</Chip> : null,
    retries !== undefined ? <Chip key="r" tone="outline">{retries === 1 ? '1 retry' : `${retries} retries`}</Chip> : null,
    withContinueOnError && continueOnError ? <Chip key="c" tone="outline">Continues on error</Chip> : null,
  ].filter(Boolean);
  const hasIssues = ADVANCED_KEYS.some((key) => issues.has(key));
  return (
    <Disclosure title="Advanced" defaultOpen={hasIssues} summary={chips.length ? <>{chips}</> : undefined}>
      <NumberField
        label="Timeout"
        suffix="seconds"
        value={timeout}
        min={1}
        placeholder="No limit"
        issues={issues.get('timeout')}
        onCommit={(value) => setOrUnset(update, 'timeout', value)}
      />
      <NumberField
        label="Retries"
        value={retries}
        min={1}
        max={10}
        integer
        placeholder="None"
        hint="Run the block again when it fails, up to this many times."
        issues={issues.get('retry')}
        onCommit={(value) => setOrUnset(update, 'retry', value === undefined ? undefined : { ...retry, max: value })}
      />
      {withContinueOnError ? (
        <ContinueOnError value={continueOnError} update={update} issues={issues.get('continueOnError')} />
      ) : null}
    </Disclosure>
  );
}

export function ContinueOnError({
  value,
  update,
  issues,
  hint,
}: {
  value: boolean;
  update: StepPatch;
  issues?: readonly Diagnostic[];
  hint?: string;
}) {
  return (
    <div className="wf-insp-switch">
      <Switch checked={value} label="Continue on error" onChange={(checked) => setOrUnset(update, 'continueOnError', checked || undefined)} />
      {hint ? <div className="if-field__hint wf-insp-switch-hint">{hint}</div> : null}
      <FieldIssues issues={issues} />
    </div>
  );
}
