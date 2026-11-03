import { useId } from 'react';
import type { AgentScope, CapabilitySource } from '@isar-flow/core';
import { AgentStone, Button, CapabilityChips, Chip } from '../../components';
import { InlineText } from './InlineText';
import type { FieldIssues, UpdateAgent } from './agentForm';

const SCOPE: Record<AgentScope, { label: string; icon: string; title: string }> = {
  workspace: { label: 'Workspace', icon: 'folder', title: 'Stored in this workspace under .isarflow/agents' },
  user: {
    label: 'User',
    icon: 'account',
    title: 'Stored in your user settings and available in every workspace',
  },
};

export function AgentHeader({
  id,
  scope,
  fileName,
  name,
  description,
  issues,
  editable,
  capabilities,
  update,
  onOpenYaml,
}: {
  id: string;
  scope: AgentScope;
  fileName: string;
  name: string;
  description: string;
  issues: FieldIssues;
  /** False while the YAML cannot be read at all. */
  editable: boolean;
  /** Tools and permissions of the form (unsaved edits included), for the capability badges. */
  capabilities: CapabilitySource | null;
  update: UpdateAgent;
  onOpenYaml: () => void;
}) {
  const errorId = useId();
  const nameIssue = issues.message('name');
  const descriptionIssue = issues.message('description');
  const problem = nameIssue.error ?? descriptionIssue.error;
  const scopeInfo = SCOPE[scope] ?? SCOPE.workspace;

  return (
    <header className="ag-header">
      <AgentStone id={id} name={name || id} size="l" />
      <div className="ag-header__text">
        <div className="ag-header__title-row">
          {editable ? (
            <InlineText
              className={nameIssue.error ? 'ag-header__name ag-header__name--invalid' : 'ag-header__name'}
              value={name}
              label="Agent name"
              placeholder="Name the agent"
              required
              invalid={Boolean(nameIssue.error)}
              describedBy={problem ? errorId : undefined}
              onCommit={(next) => update({ name: next })}
            />
          ) : (
            <h1 className="ag-header__name-static">{name || id}</h1>
          )}
          {/* The name gives way to the chips, never the other way round; they wrap below a long name. */}
          <span className="ag-header__scope">
            <Chip tone="outline" icon={scopeInfo.icon} title={scopeInfo.title}>
              {scopeInfo.label}
            </Chip>
            {capabilities ? <CapabilityChips source={capabilities} /> : null}
          </span>
        </div>
        {editable ? (
          <InlineText
            className="ag-header__description"
            value={description}
            label="Description"
            placeholder="Add a description"
            invalid={Boolean(descriptionIssue.error)}
            onCommit={(next) => (next.trim() ? update({ description: next }) : update({}, ['description']))}
          />
        ) : null}
        {problem ? (
          <div className="ag-header__error" id={errorId}>
            <i className="codicon codicon-error ag-small-icon" aria-hidden="true" />
            <span>{problem}</span>
          </div>
        ) : null}
      </div>
      <Button
        variant="ghost"
        icon="go-to-file"
        title={`Open ${fileName} in the text editor`}
        onClick={onOpenYaml}
      >
        Open YAML
      </Button>
    </header>
  );
}
