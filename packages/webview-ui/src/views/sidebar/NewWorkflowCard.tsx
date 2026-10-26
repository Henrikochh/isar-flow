import { type FormEvent, type Ref, useId, useState } from 'react';
import type { WorkflowSummary } from '@isar-flow/core';
import { Button, Field, TextInput } from '../../components';
import { slugOf, workflowLabel } from './model';
import { TemplatePicker } from './TemplatePicker';
import type { WorkflowDraft } from './viewState';

function nameError(name: string, workflows: readonly WorkflowSummary[]): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name for the workflow.';
  const clash = workflows.find((workflow) => slugOf(workflowLabel(workflow)) === slugOf(trimmed));
  return clash ? `A workflow named ${workflowLabel(clash)} already exists. Choose another name.` : undefined;
}

export function NewWorkflowCard({
  draft,
  workflows,
  onChange,
  onCreate,
  onCancel,
  inputRef,
}: {
  draft: WorkflowDraft;
  workflows: readonly WorkflowSummary[];
  onChange: (draft: WorkflowDraft) => void;
  onCreate: (draft: WorkflowDraft) => void;
  onCancel: () => void;
  /** Lets the section's New button move focus back to the name field. */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [submitted, setSubmitted] = useState(false);
  const headingId = useId();
  const templateLabelId = useId();
  const error = nameError(draft.name, workflows);
  const shownError = submitted || draft.name.trim() !== '' ? error : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!error) onCreate({ ...draft, name: draft.name.trim() });
  };

  return (
    <form
      className="sb-create"
      aria-labelledby={headingId}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <h4 className="sb-create__title" id={headingId}>
        New workflow
      </h4>
      <Field label="Name" error={shownError}>
        {({ id, describedBy, invalid }) => (
          <TextInput
            ref={inputRef}
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            autoFocus
            placeholder="e.g. Review my changes"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        )}
      </Field>
      <div className="if-field">
        <span className="if-field__label" id={templateLabelId}>
          Template
        </span>
        <TemplatePicker
          labelledBy={templateLabelId}
          value={draft.template}
          onChange={(template) => onChange({ ...draft, template })}
        />
      </div>
      <div className="sb-create__actions">
        <Button type="submit" variant="primary" icon="add">
          Create workflow
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
