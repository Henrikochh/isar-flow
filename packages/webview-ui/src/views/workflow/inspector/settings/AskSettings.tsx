/** Settings of an ask block: the question, free text or choices, the default answer and the timeout. */
import { useEffect, useState } from 'react';
import type { Diagnostic } from '@isar-flow/core';
import { Chip, Field, Select, SegmentedControl, type SelectOption } from '../../../../components';
import { NumberField, TextField, issueProps } from '../fields';
import { asNumber, asString } from '../model';
import { type AnswerMode, choicesChange, choicesOf, defaultOf } from './askModel';
import { ChoiceRows } from './ChoiceRows';
import { Disclosure, Group, setOrUnset, type SettingsProps } from './common';

const TIMEOUT_HINT = 'Without an answer in time the default is used; without a default the block fails.';

export function AskSettings({ step, stepId, update, issues }: SettingsProps) {
  const choices = choicesOf(step);
  const current = defaultOf(step);
  const hasChoices = choices.length > 0;
  const [mode, setMode] = useState<AnswerMode>(hasChoices ? 'choices' : 'free');
  const [startBlank, setStartBlank] = useState(false);

  // The document decides once it changes (an edit here, the YAML or undo).
  useEffect(() => {
    setMode(hasChoices ? 'choices' : 'free');
    setStartBlank(false);
  }, [hasChoices]);

  const chooseMode = (next: AnswerMode) => {
    if (next === mode) return;
    setMode(next);
    if (next === 'free') {
      if (hasChoices) update({}, ['choices']);
    } else if (current.trim() !== '') update({ choices: [current.trim()] });
    else setStartBlank(true);
  };

  const commitChoices = (next: string[]) => {
    if (JSON.stringify(next) === JSON.stringify(choices)) return;
    const { set, unset } = choicesChange(choices, next, current);
    update(set, unset);
  };

  return (
    <>
      <TextField
        label="Question"
        multiline
        minRows={2}
        value={asString(step.question)}
        variablesFor={stepId}
        placeholder="What should the person running the workflow decide?"
        issues={issues.get('question')}
        validate={(text) => (text.trim() === '' ? 'Enter the question to ask.' : undefined)}
        onCommit={(question) => {
          if (question.trim() !== '') update({ question });
        }}
      />
      <Group label="Answers">
        <SegmentedControl<AnswerMode>
          label="Answers"
          value={mode}
          onChange={chooseMode}
          options={[
            { value: 'free', label: 'Free text' },
            { value: 'choices', label: 'Choices' },
          ]}
        />
      </Group>
      {mode === 'choices' ? (
        <>
          <Group label="Choices" hint="Alt+Up and Alt+Down move a choice." issues={issues.get('choices')}>
            <ChoiceRows choices={choices} startBlank={startBlank} onCommit={commitChoices} />
          </Group>
          <DefaultChoice
            choices={choices}
            value={current}
            issues={issues.get('default')}
            onChange={(value) => setOrUnset(update, 'default', value)}
          />
        </>
      ) : (
        <TextField
          label="Default answer"
          value={current}
          variablesFor={stepId}
          placeholder="No default"
          hint="Used when nobody answers in time."
          issues={issues.get('default')}
          onCommit={(value) => setOrUnset(update, 'default', value.trim())}
        />
      )}
      <AskAdvanced step={step} update={update} issues={issues} />
    </>
  );
}

function DefaultChoice({
  choices,
  value,
  issues,
  onChange,
}: {
  choices: string[];
  value: string;
  issues: readonly Diagnostic[] | undefined;
  onChange: (value: string) => void;
}) {
  const options: SelectOption[] = [
    { value: '', label: 'No default' },
    ...[...new Set(choices.map((choice) => choice.trim()).filter(Boolean))].map((choice) => ({
      value: choice,
      label: choice,
    })),
  ];
  return (
    <Field label="Default answer" {...issueProps(issues, undefined, 'Used when nobody answers in time.')}>
      {({ id, describedBy, invalid }) => (
        <Select
          id={id}
          describedBy={describedBy}
          invalid={invalid}
          value={value}
          options={options}
          onChange={onChange}
        />
      )}
    </Field>
  );
}

function AskAdvanced({ step, update, issues }: Pick<SettingsProps, 'step' | 'update' | 'issues'>) {
  const timeout = asNumber(step.timeout);
  return (
    <Disclosure
      title="Advanced"
      defaultOpen={issues.has('timeout')}
      summary={timeout !== undefined ? <Chip tone="outline">{`Timeout ${timeout} s`}</Chip> : undefined}
    >
      <NumberField
        label="Timeout"
        suffix="seconds"
        value={timeout}
        min={1}
        placeholder="No limit"
        hint={TIMEOUT_HINT}
        issues={issues.get('timeout')}
        onCommit={(value) => setOrUnset(update, 'timeout', value)}
      />
    </Disclosure>
  );
}
