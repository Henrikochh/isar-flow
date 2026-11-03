/**
 * Workflow settings "Triggers": run on save, when files change, and on a schedule (`on:`). A trigger that is just
 * switched on stays local until it has a pattern or a valid interval, so the file never holds an empty one.
 */
import './triggers.css';
import { useState } from 'react';
import { type Diagnostic, formatEvery, parseDuration, type Workflow } from '@isar-flow/core';
import { Button, Field, Section, Switch, TextInput } from '../../../../components';
import { useDraft } from '../../../../hooks';
import { useWorkflowActions } from '../../store';
import { FieldIssues } from '../Issues';
import { ListEditor } from '../RowEditors';
import {
  everyOf,
  everyProblem,
  type FileTriggerKind,
  onOf,
  onOp,
  patternsOf,
  withTrigger,
} from './triggersModel';

const NOTE =
  'Triggers run while VS Code is open, in trusted workspaces, after you ran the workflow once and chose Run and remember.';
const PATTERN_HINT = 'Relative to the workspace folder, e.g. src/**/*.ts. Start with ! to exclude.';

const PRESETS = [
  { every: '15m', label: '15 min' },
  { every: '1h', label: '1 hour' },
  { every: '1d', label: '1 day' },
];

type Kind = FileTriggerKind | 'schedule';

const FILE_TRIGGERS: { kind: FileTriggerKind; label: string; rows: string }[] = [
  { kind: 'save', label: 'Run on save', rows: 'Files to watch on save' },
  { kind: 'change', label: 'Run when files change', rows: 'Files to watch for changes' },
];

function ScheduleField({ every, onCommit }: { every: string | null; onCommit: (every: string) => void }) {
  const draft = useDraft(every ?? '', (text) => {
    const value = text.trim();
    if (value !== '' && !everyProblem(value) && value !== every) onCommit(value);
  });
  const problem = everyProblem(draft.value);
  const ms = problem ? undefined : parseDuration(draft.value.trim());
  return (
    <Field
      label="Every"
      error={problem}
      hint={ms !== undefined ? formatEvery(ms) : 'For example 15m, 1h or 1h30m.'}
    >
      {({ id, describedBy, invalid }) => (
        <div className="wf-insp-every">
          <TextInput
            id={id}
            code
            aria-describedby={describedBy}
            invalid={invalid}
            className="wf-insp-every-input"
            placeholder="1h"
            autoFocus={every === null}
            value={draft.value}
            onChange={(event) => draft.change(event.target.value)}
            onBlur={draft.flush}
            onKeyDown={(event) => {
              if (event.key === 'Enter') draft.flush();
            }}
          />
          <span className="wf-insp-presets" role="group" aria-label="Presets">
            {PRESETS.map((preset) => (
              <Button
                key={preset.every}
                size="s"
                variant="secondary"
                aria-pressed={draft.value.trim() === preset.every}
                onClick={() => {
                  draft.change(preset.every);
                  draft.flush();
                }}
              >
                {preset.label}
              </Button>
            ))}
          </span>
        </div>
      )}
    </Field>
  );
}

export function TriggerSettings({
  workflow,
  issues,
}: {
  workflow: Workflow;
  issues: Map<string, Diagnostic[]>;
}) {
  const actions = useWorkflowActions();
  const on = onOf(workflow);
  const [pending, setPending] = useState<Record<Kind, boolean>>({
    save: false,
    change: false,
    schedule: false,
  });
  const setLocal = (kind: Kind, value: boolean) => setPending((current) => ({ ...current, [kind]: value }));
  const write = (kind: Kind, value: unknown) => {
    setLocal(kind, false);
    actions.applyOps([onOp(withTrigger(on, kind, value))]);
  };
  const every = everyOf(on);
  const scheduleOn = every !== null || pending.schedule;

  return (
    <Section title="Triggers">
      <p className="wf-insp-section-hint">{NOTE}</p>
      {FILE_TRIGGERS.map(({ kind, label, rows }) => {
        const files = patternsOf(on, kind);
        const enabled = files !== null || pending[kind];
        return (
          <div key={kind} className="wf-insp-trigger">
            <Switch
              checked={enabled}
              label={label}
              onChange={(checked) => {
                if (checked) setLocal(kind, files === null);
                else if (files !== null) write(kind, undefined);
                else setLocal(kind, false);
              }}
            />
            {enabled ? (
              <div className="wf-insp-trigger-body">
                <ListEditor
                  values={files ?? []}
                  label={rows}
                  noun="Pattern"
                  addLabel="Add pattern"
                  placeholder="src/**/*.ts"
                  startBlank={files === null}
                  onCommit={(next) => write(kind, next.length ? { files: next } : undefined)}
                />
                <div className="if-field__hint">{PATTERN_HINT}</div>
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="wf-insp-trigger">
        <Switch
          checked={scheduleOn}
          label="Run on a schedule"
          onChange={(checked) => {
            if (checked) setLocal('schedule', every === null);
            else if (every !== null) write('schedule', undefined);
            else setLocal('schedule', false);
          }}
        />
        {scheduleOn ? (
          <div className="wf-insp-trigger-body">
            <ScheduleField every={every} onCommit={(value) => write('schedule', { every: value })} />
          </div>
        ) : null}
      </div>
      <FieldIssues issues={issues.get('on')} />
    </Section>
  );
}

export function CopilotSettings({
  workflow,
  issues,
}: {
  workflow: Workflow;
  issues: Map<string, Diagnostic[]>;
}) {
  const actions = useWorkflowActions();
  const exposed = workflow.expose === true;
  return (
    <Section title="Copilot">
      <div className="wf-insp-switch">
        <Switch
          checked={exposed}
          label="Let Copilot run this workflow"
          onChange={(checked) =>
            actions.applyOps([
              checked
                ? { op: 'updateWorkflow', set: { expose: true } }
                : { op: 'updateWorkflow', set: {}, unset: ['expose'] },
            ])
          }
        />
        <div className="if-field__hint wf-insp-switch-hint">
          Copilot can list and run it with @isarflow and its tools. You still confirm its commands.
        </div>
        <FieldIssues issues={issues.get('expose')} />
      </div>
    </Section>
  );
}
