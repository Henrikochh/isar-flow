import { TOOL_INFO, TOOL_NAMES, type ToolInfo, type ToolName } from '@isar-flow/core';
import { Checkbox, Section } from '../../components';
import type { UpdateAgent } from './agentForm';

const GROUPS: { risk: ToolInfo['risk']; title: string; icon: string; hint: string }[] = [
  { risk: 'read', title: 'Read only', icon: 'eye', hint: 'These tools never change your workspace.' },
  { risk: 'edit', title: 'Edits files', icon: 'edit', hint: 'What happens depends on the Edit files permission.' },
  { risk: 'command', title: 'Runs commands', icon: 'terminal', hint: 'What happens depends on the Run commands permission.' },
];

/** Tools in canonical order; names the schema does not know are kept at the end so nothing is lost. */
function nextTools(current: string[], tool: ToolName, on: boolean): ToolName[] {
  const known = TOOL_NAMES.filter((name) => (name === tool ? on : current.includes(name)));
  const unknown = current.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name));
  return [...known, ...(unknown as ToolName[])];
}

export function ToolsSection({ tools, error, update }: { tools: string[]; error?: string; update: UpdateAgent }) {
  const enabled = TOOL_NAMES.filter((name) => tools.includes(name)).length;
  return (
    <Section
      title="Tools"
      actions={
        <span className="ag-section-count">
          {enabled} of {TOOL_NAMES.length} on
        </span>
      }
    >
      {error ? (
        <div className="ag-inline-error" role="alert">
          <i className="codicon codicon-error ag-small-icon" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="ag-tool-groups">
        {GROUPS.map((group) => (
          <div key={group.risk} className="ag-tool-group" role="group" aria-label={group.title}>
            <div className="ag-tool-group__header">
              <i className={`codicon codicon-${group.icon} ag-tool-group__icon ag-risk-${group.risk}`} aria-hidden="true" />
              <span className="ag-tool-group__title">{group.title}</span>
              <span className="ag-tool-group__hint">{group.hint}</span>
            </div>
            {TOOL_NAMES.filter((name) => TOOL_INFO[name].risk === group.risk).map((name) => (
              <div key={name} className="ag-tool">
                <div className="ag-tool__check">
                  <Checkbox
                    checked={tools.includes(name)}
                    label={TOOL_INFO[name].label}
                    description={TOOL_INFO[name].description}
                    onChange={(on) => update({ tools: nextTools(tools, name, on) })}
                  />
                </div>
                <code className="ag-tool__name">{name}</code>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}
