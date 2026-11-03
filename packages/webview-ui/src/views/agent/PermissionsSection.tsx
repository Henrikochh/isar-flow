import { useId } from 'react';
import {
  TOOL_INFO,
  TOOL_NAMES,
  type AgentPermissions,
  type PermissionLevel,
  type ToolName,
} from '@isar-flow/core';
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
    tools: TOOL_NAMES.filter((tool) => TOOL_INFO[tool].risk === 'edit'),
    off: 'Turn on Edit files, Apply patches or Write files under Tools to use this.',
    describe: {
      none: 'Every edit is refused.',
      ask: 'VS Code asks you before each change.',
      auto: 'Changes are applied without asking. You can undo them.',
    },
  },
  commands: {
    label: 'Run commands',
    tools: TOOL_NAMES.filter((tool) => TOOL_INFO[tool].risk === 'command'),
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
  // A missing level means "ask": the tool host asks before every change or command it was not told about.
  const current = level ?? 'ask';
  const hint = !active ? info.off : level === undefined ? 'Not set — asks each time' : info.describe[level];
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
            {hint}
          </span>
        )}
      </div>
      <fieldset className="ag-permission__control" disabled={!active} aria-describedby={hintId}>
        <SegmentedControl label={info.label} value={current} options={LEVELS} onChange={onChange} />
      </fieldset>
    </div>
  );
}

export function PermissionsSection({
  form,
  issues,
  update,
}: {
  form: AgentForm;
  issues: FieldIssues;
  update: UpdateAgent;
}) {
  const set = (gate: Gate) => (level: PermissionLevel) => {
    // Choosing the shown default of an unset level still writes it, so the file states it.
    if (level === form[gate]) return;
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
