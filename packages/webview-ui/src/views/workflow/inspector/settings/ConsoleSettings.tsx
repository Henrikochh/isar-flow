import type { ShellName } from '@isar-flow/core';
import { Field, Select, type SelectOption } from '../../../../components';
import { issueProps, TextField } from '../fields';
import { asString, asStringEntries } from '../model';
import { KeyValueEditor } from '../RowEditors';
import { AdvancedSettings, ContinueOnError, Group, setOrUnset, type SettingsProps } from './common';

const SHELLS: SelectOption<ShellName>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'pwsh', label: 'PowerShell 7' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'cmd', label: 'Command Prompt' },
  { value: 'bash', label: 'Bash' },
  { value: 'sh', label: 'sh' },
];

export function ConsoleSettings(props: SettingsProps) {
  const { step, stepId, update, issues } = props;
  const shell = asString(step.shell) || 'auto';
  return (
    <>
      <TextField
        label="Command"
        code
        multiline
        minRows={2}
        maxRows={14}
        value={asString(step.run)}
        variablesFor={stepId}
        placeholder="npm test"
        issues={issues.get('run')}
        onCommit={(run) => update({ run })}
      />

      <Field label="Shell" {...issueProps(issues.get('shell'))}>
        {({ id, describedBy, invalid }) => (
          <Select<string>
            id={id}
            describedBy={describedBy}
            invalid={invalid}
            value={shell}
            options={SHELLS.some((s) => s.value === shell) ? SHELLS : [...SHELLS, { value: shell, label: shell, description: 'Unknown shell' }]}
            onChange={(value) => setOrUnset(update, 'shell', value === 'auto' ? undefined : value)}
          />
        )}
      </Field>

      <TextField
        label="Working folder"
        code
        value={asString(step.cwd)}
        variablesFor={stepId}
        placeholder="Workspace root"
        issues={issues.get('cwd')}
        onCommit={(cwd) => setOrUnset(update, 'cwd', cwd.trim())}
      />

      <Group label="Environment" issues={issues.get('env')}>
        <KeyValueEditor
          entries={asStringEntries(step.env)}
          noun="variable"
          addLabel="Add variable"
          onCommit={(entries) => setOrUnset(update, 'env', entries.length ? Object.fromEntries(entries) : undefined)}
        />
      </Group>

      <ContinueOnError
        value={step.continueOnError === true}
        update={update}
        issues={issues.get('continueOnError')}
        hint="Keep going when the command fails, so a condition can check the exit code"
      />

      <AdvancedSettings {...props} withContinueOnError={false} />
    </>
  );
}
