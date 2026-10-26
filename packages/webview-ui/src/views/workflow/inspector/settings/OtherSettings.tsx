import { STEP_TYPES } from '@isar-flow/core';
import { Banner, Button, SegmentedControl } from '../../../../components';
import { useWorkflowActions } from '../../store';
import { ConditionBuilder } from '../ConditionBuilder';
import { TextField } from '../fields';
import { asString } from '../model';
import { Group, setOrUnset, type SettingsProps } from './common';

export function IfSettings({ step, stepId, update, issues }: SettingsProps) {
  return (
    <ConditionBuilder
      stepId={stepId}
      accent="if"
      condition={step.condition}
      summaryPrefix="If"
      issues={issues.get('condition')}
      onChange={(condition) => update({ condition })}
    />
  );
}

/** Whether the block sits in a loop is reported by validation (break-outside-loop) at the top. */
export function BreakSettings() {
  return <p className="wf-insp-explain">Leaves the innermost loop immediately.</p>;
}

export function StopSettings({ step, stepId, update, issues }: SettingsProps) {
  return (
    <>
      <Group label="End the run as" issues={issues.get('outcome')}>
        <SegmentedControl<'failure' | 'success'>
          label="End the run as"
          value={step.outcome === 'success' ? 'success' : 'failure'}
          onChange={(outcome) => update({ outcome })}
          options={[
            { value: 'failure', label: 'Failed', icon: 'error' },
            { value: 'success', label: 'Succeeded', icon: 'pass' },
          ]}
        />
      </Group>
      <TextField
        label="Message"
        multiline
        minRows={2}
        value={asString(step.message)}
        variablesFor={stepId}
        placeholder="Why the run ends here"
        issues={issues.get('message')}
        onCommit={(message) => setOrUnset(update, 'message', message)}
      />
    </>
  );
}

export function ApprovalSettings({ step, stepId, update, issues }: SettingsProps) {
  return (
    <>
      <TextField
        label="Message"
        multiline
        minRows={2}
        value={asString(step.message)}
        variablesFor={stepId}
        placeholder="What should be approved?"
        hint="Shown when the run pauses for your decision."
        issues={issues.get('message')}
        onCommit={(message) => update({ message })}
      />
      <Group label="If rejected" issues={issues.get('onReject')}>
        <SegmentedControl<'stop' | 'continue'>
          label="If rejected"
          value={step.onReject === 'continue' ? 'continue' : 'stop'}
          onChange={(value) => setOrUnset(update, 'onReject', value === 'continue' ? 'continue' : undefined)}
          options={[
            { value: 'stop', label: 'Stop the run' },
            { value: 'continue', label: 'Continue' },
          ]}
        />
      </Group>
    </>
  );
}

export function UnknownSettings({ step, stepId }: SettingsProps) {
  const actions = useWorkflowActions();
  const type = asString(step.type);
  return (
    <Banner
      tone="warning"
      title={type ? `Unknown block type '${type}'` : 'This block has no type'}
      actions={
        <Button size="s" variant="secondary" icon="go-to-file" onClick={() => actions.openYaml(stepId)}>
          Show in YAML
        </Button>
      }
    >
      Set type to one of {STEP_TYPES.join(', ')} in the YAML.
    </Banner>
  );
}
