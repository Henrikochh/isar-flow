import type { ReactNode } from 'react';
import {
  AgentStone,
  Button,
  Chip,
  Field,
  IconButton,
  ModelPicker,
  SegmentedControl,
  Select,
  type SelectOption,
  Switch,
} from '../../../../components';
import { useWorkflowActions, useWorkflowState } from '../../store';
import { issueProps, TextField } from '../fields';
import { FieldIssues } from '../Issues';
import { asString, asStringList, isInsideLoop, isRecord } from '../model';
import { ListEditor } from '../RowEditors';
import { AdvancedSettings, Group, setOrUnset, type SettingsProps } from './common';
import { JsonFieldsEditor } from './JsonFieldsEditor';

const NO_AGENT = '__no-agent__';
const INLINE_AGENT = '__inline-agent__';

export function AgentSettings(props: SettingsProps) {
  const { step, stepId, update, issues, block } = props;
  const { agents, catalog } = useWorkflowState();
  const actions = useWorkflowActions();

  const agentId = typeof step.agent === 'string' ? step.agent : undefined;
  const inline = isRecord(step.agent);
  const agent = agents.find((a) => a.id === agentId && !a.shadowed) ?? agents.find((a) => a.id === agentId);
  const model = asString(step.model);
  const output = isRecord(step.output) ? step.output : undefined;
  const format = output?.format === 'json' ? 'json' : 'text';
  const context = isRecord(step.context) ? step.context : undefined;

  const options: SelectOption[] = [
    {
      value: NO_AGENT,
      label: 'No agent — use a model directly',
      leading: <i className="codicon codicon-circle-slash wf-insp-option-icon" aria-hidden="true" />,
    },
    ...agents
      .filter((a) => !a.shadowed)
      .map<SelectOption>((a) => ({
        value: a.id,
        label: a.name,
        description: a.model,
        leading: <AgentStone id={a.id} name={a.name} size="s" />,
        meta: a.scope === 'user' ? <Chip tone="outline">User</Chip> : undefined,
      })),
  ];
  if (agentId && !agent) {
    // Agents arrive with the model catalog; until then an id is not known to be wrong.
    const loading = catalog.loading && agents.length === 0;
    options.push({
      value: agentId,
      label: agentId,
      description: loading ? 'Loading agents…' : 'No agent file with this id',
      leading: loading ? undefined : (
        <i className="codicon codicon-warning wf-insp-option-icon wf-insp-option-icon--warn" aria-hidden="true" />
      ),
    });
  }
  if (inline) {
    options.push({ value: INLINE_AGENT, label: 'Inline agent settings', description: 'Defined in this block in the YAML', disabled: true });
  }

  // Without an agent or a model, validation reports agent-missing at the Agent field.
  const modelHint: ReactNode = agent ? (
    <>
      {agent.name} uses <code>{agent.model}</code>
    </>
  ) : undefined;

  return (
    <>
      <Field label="Agent" {...issueProps(props.issues.get('agent'), undefined, inline ? 'This block defines its agent inline. Edit it in YAML.' : undefined)}>
        {({ id, describedBy, invalid }) => (
          <div className="wf-insp-inline">
            <div className="wf-insp-grow">
            <Select
              id={id}
              describedBy={describedBy}
              invalid={invalid}
              value={inline ? INLINE_AGENT : (agentId ?? NO_AGENT)}
              options={options}
              searchable={options.length > 7}
              onChange={(value) => {
                if (value === NO_AGENT) update({}, ['agent']);
                else if (value !== INLINE_AGENT) update({ agent: value });
              }}
              footer={
                <div className="wf-insp-select-footer">
                  <Button size="s" variant="ghost" icon="add" onClick={() => actions.createAgent()}>
                    New agent
                  </Button>
                </div>
              }
            />
            </div>
            {agent ? (
              <IconButton icon="go-to-file" label={`Open ${agent.name}`} onClick={() => actions.openAgent(agent.id)} />
            ) : null}
          </div>
        )}
      </Field>

      <Field label="Model" {...issueProps(issues.get('model'), undefined, modelHint)}>
        {({ id, describedBy, invalid }) => (
          <ModelPicker
            id={id}
            describedBy={describedBy}
            invalid={invalid}
            value={model || undefined}
            catalog={catalog}
            emptyOption={agentId || inline ? "Use the agent's model" : undefined}
            placeholder="Choose a model"
            onChange={(ref) => setOrUnset(update, 'model', ref)}
            onRefresh={actions.refreshModels}
          />
        )}
      </Field>

      <TextField
        label="Task"
        multiline
        minRows={4}
        maxRows={20}
        value={asString(step.prompt)}
        variablesFor={stepId}
        placeholder="Describe what the agent should do. Insert outputs of earlier blocks with {x}."
        issues={issues.get('prompt')}
        onCommit={(prompt) => update({ prompt })}
      />

      <Group label="Answer format" issues={format === 'text' ? issues.get('output') : undefined}>
        <SegmentedControl<'text' | 'json'>
          label="Answer format"
          value={format}
          options={[
            { value: 'text', label: 'Text' },
            { value: 'json', label: 'JSON' },
          ]}
          onChange={(next) => {
            if (next === 'json') update({ output: { ...output, format: 'json' } });
            else if (output?.schema !== undefined) update({ output: { ...output, format: 'text' } });
            else update({}, ['output']);
          }}
        />
      </Group>

      {format === 'json' ? (
        <Group label="JSON fields" description="The agent is asked to answer in this shape. Later blocks read the fields.">
          <JsonFieldsEditor
            schema={output?.schema}
            issues={issues.get('output')}
            onShowYaml={() => actions.openYaml(stepId)}
            onCommit={(shape) =>
              update({ output: Object.keys(shape).length ? { format: 'json', schema: shape } : { format: 'json' } })
            }
          />
        </Group>
      ) : null}

      <div className="wf-insp-switch">
        <Switch
          checked={step.session === 'continue'}
          label="Remember the conversation between loop iterations"
          onChange={(checked) => setOrUnset(update, 'session', checked ? 'continue' : undefined)}
        />
        {isInsideLoop(block) ? null : <div className="if-field__hint wf-insp-switch-hint">Only has an effect inside a loop.</div>}
        <FieldIssues issues={issues.get('session')} />
      </div>

      <Group label="Context files" description="Files matching these patterns are attached to the task." issues={issues.get('context')}>
        <ListEditor
          values={asStringList(context?.files)}
          noun="File pattern"
          addLabel="Add file pattern"
          placeholder="src/**/*.ts"
          onCommit={(files) => {
            if (files.length) update({ context: { ...context, files } });
            else update({}, ['context']);
          }}
        />
      </Group>

      <AdvancedSettings {...props} withContinueOnError />
    </>
  );
}
