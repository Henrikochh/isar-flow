import { TOOL_INFO, TOOL_NAMES, type ToolInfo, type ToolName } from '@isar-flow/core';
import { Checkbox, Section } from '../../components';
import type { UpdateAgent } from './agentForm';

const GROUPS: { risk: ToolInfo['risk']; title: string; icon: string; hint: string }[] = [
  { risk: 'read', title: 'Read-only', icon: 'eye', hint: 'These tools never change your workspace.' },
  {
    risk: 'edit',
    title: 'Edits files',
    icon: 'edit',
    hint: 'What happens depends on the Edit files permission.',
  },
  {
    risk: 'command',
    title: 'Runs commands',
    icon: 'terminal',
    hint: 'What happens depends on the Run commands permission.',
  },
];

/** Same words as the Blank starter, so a new read-only agent explains itself. */
export const READ_ONLY_HINT =
  'Read-only: it can look at files but not change them. Turn on Edit files to let it change code.';

/** Tools in canonical order; names the schema does not know are kept at the end so nothing is lost. */
function nextTools(current: string[], tool: ToolName, on: boolean): ToolName[] {
  const known = TOOL_NAMES.filter((name) => (name === tool ? on : current.includes(name)));
  const unknown = current.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name));
  return [...known, ...(unknown as ToolName[])];
}

export function ToolsSection({
  tools,
  error,
  update,
}: {
  tools: string[];
  error?: string;
  update: UpdateAgent;
}) {
  const enabled = TOOL_NAMES.filter((name) => tools.includes(name)).length;
  const readOnly = !TOOL_NAMES.some((name) => TOOL_INFO[name].risk !== 'read' && tools.includes(name));
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
      {readOnly ? (
        <p className="ag-read-only">
          <i className="codicon codicon-info ag-small-icon" aria-hidden="true" />
          <span>{READ_ONLY_HINT}</span>
        </p>
      ) : null}
      <div className="ag-tool-groups">
        {GROUPS.map((group) => (
          <div key={group.risk} className="ag-tool-group" role="group" aria-label={group.title}>
            <div className="ag-tool-group__header">
              <i
                className={`codicon codicon-${group.icon} ag-tool-group__icon ag-risk-${group.risk}`}
                aria-hidden="true"
              />
              {/* One run of text, so a wrapped hint lines up under the title instead of the icon. */}
              <span className="ag-tool-group__text">
                <span className="ag-tool-group__title">{group.title}</span>{' '}
                <span className="ag-tool-group__hint">{group.hint}</span>
              </span>
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
