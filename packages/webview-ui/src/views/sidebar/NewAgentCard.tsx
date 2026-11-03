import { type FormEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react';
import type { AgentScope, AgentStarter, AgentSummary } from '@isar-flow/core';
import { Button, Field, SegmentedControl, TextInput, type SegmentOption } from '../../components';
import { agentLabel, slugOf } from './model';
import type { AgentDraft } from './viewState';

const STARTER_OPTIONS: SegmentOption<AgentStarter>[] = [
  { value: 'blank', label: 'Blank' },
  { value: 'coder', label: 'Coder' },
  { value: 'reviewer', label: 'Reviewer' },
];

const STARTER_HINTS: Record<AgentStarter, string> = {
  blank: 'Read-only: it can look at files but not change them. Turn on Edit files to let it change code.',
  coder: 'Implements tasks: edits files and asks before running commands.',
  reviewer: 'Reviews changes without editing and answers in JSON.',
};

/** Name a starter fills in, so picking one is enough to create a useful agent. */
const STARTER_NAMES: Record<AgentStarter, string> = { blank: '', coder: 'Coder', reviewer: 'Reviewer' };

const SCOPE_OPTIONS: SegmentOption<AgentScope>[] = [
  { value: 'workspace', label: 'Workspace' },
  { value: 'user', label: 'User' },
];

const SCOPE_HINTS: Record<AgentScope, ReactNode> = {
  workspace: (
    <>
      Saved in <span className="sb-code">.isarflow/agents</span> and shared with the repository.
    </>
  ),
  user: 'Saved in your user profile and available in every workspace.',
};

function nameError(draft: AgentDraft, agents: readonly AgentSummary[]): string | undefined {
  const name = draft.name.trim();
  if (!name) return 'Enter a name for the agent.';
  const slug = slugOf(name);
  const clash = agents.find(
    (agent) =>
      agent.scope === draft.scope &&
      (agentLabel(agent).toLowerCase() === name.toLowerCase() || (slug !== '' && agent.id === slug)),
  );
  if (!clash) return undefined;
  return draft.scope === 'user'
    ? `You already have a user agent named ${agentLabel(clash)}. Choose another name.`
    : `This workspace already has an agent named ${agentLabel(clash)}. Choose another name.`;
}

export function NewAgentCard({
  draft,
  agents,
  onChange,
  onCreate,
  onCancel,
  inputRef,
}: {
  draft: AgentDraft;
  agents: readonly AgentSummary[];
  onChange: (draft: AgentDraft) => void;
  onCreate: (draft: AgentDraft) => void;
  onCancel: () => void;
  /** Lets the section's New button move focus back to the name field. */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [submitted, setSubmitted] = useState(false);
  const headingId = useId();
  const error = nameError(draft, agents);
  const shownError = submitted || draft.name.trim() !== '' ? error : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!error) onCreate({ ...draft, name: draft.name.trim() });
  };

  const pickStarter = (starter: AgentStarter) => {
    const untouched = draft.name.trim() === '' || draft.name === STARTER_NAMES[draft.starter];
    onChange({ ...draft, starter, name: untouched ? STARTER_NAMES[starter] : draft.name });
  };

  // The suggestion disappears once Coder is picked, so focus moves to the chosen starter instead of the page.
  const starterRef = useRef<HTMLDivElement>(null);
  const [focusStarter, setFocusStarter] = useState(false);
  useEffect(() => {
    if (!focusStarter) return;
    setFocusStarter(false);
    starterRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [focusStarter]);

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
        New agent
      </h4>
      <Field label="Name" error={shownError}>
        {({ id, describedBy, invalid }) => (
          <TextInput
            ref={inputRef}
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            autoFocus
            placeholder="e.g. Translator"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        )}
      </Field>
      <div className="if-field" ref={starterRef}>
        <span className="if-field__label">Starter</span>
        <SegmentedControl
          label="Starter"
          full
          value={draft.starter}
          options={STARTER_OPTIONS}
          onChange={pickStarter}
        />
        <span className="if-field__hint">{STARTER_HINTS[draft.starter]}</span>
        {draft.starter === 'blank' ? (
          <Button
            variant="link"
            className="sb-create__suggest"
            onClick={() => {
              pickStarter('coder');
              setFocusStarter(true);
            }}
          >
            For an agent that should change code, pick Coder.
          </Button>
        ) : null}
      </div>
      <div className="if-field">
        <span className="if-field__label">Scope</span>
        <SegmentedControl
          label="Scope"
          full
          value={draft.scope}
          options={SCOPE_OPTIONS}
          onChange={(scope) => onChange({ ...draft, scope })}
        />
        <span className="if-field__hint">{SCOPE_HINTS[draft.scope]}</span>
      </div>
      <div className="sb-create__actions">
        <Button type="submit" variant="primary" icon="add">
          Create agent
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
