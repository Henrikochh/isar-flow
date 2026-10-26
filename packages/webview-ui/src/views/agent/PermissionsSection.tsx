import { useId } from 'react';
import type { AgentPermissions, PermissionLevel, ToolName } from '@isar-flow/core';
import { SegmentedControl, Section, type SegmentOption } from '../../components';
import type { AgentForm, FieldIssues, UpdateAgent } from './agentForm';

const LEVELS: SegmentOption<PermissionLevel>[] = [
  { value: 'none', label: 'Never' },
  { value: 'ask', label: 'Ask' },
  { value: 'auto', label: 'Always' },
];

type Gate = 'edits' | 'commands';

const GATES: Record<
  Gate,
  { label: string; tools: ToolName[]; off: string; describe: Record<PermissionLevel, string> }
> = {
  edits: {
    label: 'Edit files',
    tools: ['editFile', 'writeFile'],
    off: 'Turn on Edit files or Write files under Tools to use this.',
    describe: {
      none: 'Every edit is refused.',
      ask: 'VS Code asks you before each change.',
      auto: 'Changes are applied without asking. You can undo them.',
    },
  },
  commands: {
    label: 'Run commands',
    tools: ['runCommand'],
    off: 'Turn on Run commands under Tools to use this.',
    describe: {
      none: 'Every command is refused.',
      ask: 'VS Code asks you before each command.',
      auto: 'Commands run without asking.',
    },
  },
};

function PermissionRow({
  gate,
  level,
  active,
  error,
  onChange,
}: {
  gate: Gate;
  level: PermissionLevel | undefined;
  active: boolean;
  error?: string;
  onChange: (level: PermissionLevel) => void;
}) {
  const info = GATES[gate];
  const hintId = useId();
  // Missing levels mean "none": the tool host refuses anything it was not allowed to do.
  const current = level ?? 'none';
  return (
    <div className="ag-permission">
      <div className="ag-permission__text">
        <span className="ag-permission__label">{info.label}</span>
        {error ? (
          <span className="ag-permission__error" id={hintId}>
            <i className="codicon codicon-error ag-small-icon" aria-hidden="true" />
            {error}
          </span>
        ) : (
          <span className="ag-permission__hint" id={hintId}>
            {active ? info.describe[current] : info.off}
          </span>
        )}
      </div>
      <fieldset className="ag-permission__control" disabled={!active} aria-describedby={hintId}>
        <SegmentedControl label={info.label} value={current} options={LEVELS} onChange={onChange} />
      </fieldset>
    </div>
  );
}

export function PermissionsSection({ form, issues, update }: { form: AgentForm; issues: FieldIssues; update: UpdateAgent }) {
  const set = (gate: Gate) => (level: PermissionLevel) => {
    if (level === (form[gate] ?? 'none')) return;
    const permissions: AgentPermissions = {};
    const edits = gate === 'edits' ? level : form.edits;
    const commands = gate === 'commands' ? level : form.commands;
    if (edits) permissions.edits = edits;
    if (commands) permissions.commands = commands;
    update({ permissions });
  };
  const generalError = issues.message('permissions').error;
  return (
    <Section title="Permissions">
      {generalError ? (
        <div className="ag-inline-error" role="alert">
          <i className="codicon codicon-error ag-small-icon" aria-hidden="true" />
          <span>{generalError}</span>
        </div>
      ) : null}
      <div className="ag-permissions">
        {(Object.keys(GATES) as Gate[]).map((gate) => (
          <PermissionRow
            key={gate}
            gate={gate}
            level={form[gate]}
            active={GATES[gate].tools.some((tool) => form.tools.includes(tool))}
            error={issues.message(`permissions.${gate}`).error}
            onChange={set(gate)}
          />
        ))}
      </div>
    </Section>
  );
}
