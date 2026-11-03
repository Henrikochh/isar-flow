import type { WorkflowOp } from '@isar-flow/core';
import { Section } from '../../../../components';
import { useWorkflowActions, useWorkflowState } from '../../store';
import { TextField } from '../fields';
import { FieldIssues } from '../Issues';
import { asString, asStringEntries, workflowIssues } from '../model';
import { KeyValueEditor } from '../RowEditors';
import { InputsEditor } from './InputsEditor';
import { IsolationSettings } from './IsolationSettings';
import { RunHistory } from './RunHistory';
import { CopilotSettings, TriggerSettings } from './TriggerSettings';

/** Inspector content when no block is selected: workflow settings and run history. */
export function WorkflowPanel({ withHeader = true }: { withHeader?: boolean }) {
  const { doc } = useWorkflowState();
  const actions = useWorkflowActions();
  const workflow = doc?.workflow;
  if (!doc || !workflow) return null;
  const issues = workflowIssues(doc.diagnostics);

  const updateWorkflow = (key: string, value: unknown) => {
    const op: WorkflowOp =
      value === undefined || value === ''
        ? { op: 'updateWorkflow', set: {}, unset: [key] }
        : { op: 'updateWorkflow', set: { [key]: value } };
    actions.applyOps([op]);
  };

  return (
    <>
      {withHeader ? (
        <header className="wf-insp-head">
          <div className="wf-insp-head-row">
            <span className="if-stone if-stone--l" data-type="agent" aria-hidden="true">
              <i className="codicon codicon-pulse" />
            </span>
            <div className="wf-insp-head-titles">
              <h2 className="wf-insp-title if-display">Workflow</h2>
              <span className="wf-insp-file">{doc.fileName}</span>
            </div>
          </div>
        </header>
      ) : null}
      <div className="wf-insp-form">
        <TextField
          label="Name"
          value={asString(workflow.name)}
          issues={issues.get('name')}
          placeholder="Name shown on the canvas and in the sidebar"
          onCommit={(name) => {
            if (name.trim() !== '') updateWorkflow('name', name.trim());
          }}
          validate={(text) => (text.trim() === '' ? 'Enter a name for the workflow.' : undefined)}
        />
        <TextField
          label="Description"
          multiline
          minRows={2}
          maxRows={8}
          value={asString(workflow.description)}
          issues={issues.get('description')}
          placeholder="What this workflow does"
          onCommit={(description) => updateWorkflow('description', description.trim())}
        />
        <IsolationSettings workflow={workflow} issues={issues} />
        <hr className="if-divider" />
        <Section title="Inputs">
          <p className="wf-insp-section-hint">
            Asked for when the run starts. Blocks read them as inputs.name.
          </p>
          <InputsEditor inputs={workflow.inputs} onCommit={(inputs) => updateWorkflow('inputs', inputs)} />
          <FieldIssues issues={issues.get('inputs')} />
        </Section>
        <hr className="if-divider" />
        <Section title="Environment variables">
          <p className="wf-insp-section-hint">Set for every console command and readable as env.NAME.</p>
          <KeyValueEditor
            entries={asStringEntries(workflow.env)}
            noun="variable"
            addLabel="Add variable"
            onCommit={(entries) =>
              updateWorkflow('env', entries.length ? Object.fromEntries(entries) : undefined)
            }
          />
          <FieldIssues issues={issues.get('env')} />
        </Section>
        <hr className="if-divider" />
        <TriggerSettings workflow={workflow} issues={issues} />
        <hr className="if-divider" />
        <CopilotSettings workflow={workflow} issues={issues} />
        <hr className="if-divider" />
        <Section title="Runs">
          <RunHistory />
        </Section>
      </div>
    </>
  );
}
