/** Top bar of the workflow editor: name, file, validation, runs, Open YAML and Run / Stop. */
import './topbar.css';
import { useId, useState } from 'react';
import { Button } from '../../../components';
import { formatDuration } from '../../../hooks';
import { useEditor } from '../editorContext';
import { useWorkflowActions, useWorkflowState } from '../store';
import { declaredInputs, InputsDialog } from './InputsDialog';
import { NameEditor } from './NameEditor';
import { RunsMenu } from './RunsMenu';
import { useRunElapsed } from './useRunElapsed';
import { ValidationPill } from './ValidationPill';

/** Why the workflow cannot run right now, or null when it can. */
export function runBlocker(
  trusted: boolean,
  valid: boolean,
  readable: boolean,
  problems: number,
  blocks: number,
): string | null {
  if (!trusted) return 'Running is disabled until you trust this workspace.';
  if (!readable) return "Fix the YAML first: the file can't be read.";
  if (!valid)
    return problems === 1
      ? 'Fix the problem before running.'
      : `Fix the ${problems} problems before running.`;
  if (blocks === 0) return 'Add a block before running.';
  return null;
}

export function TopBar() {
  const { doc, trusted, run, runLive } = useWorkflowState();
  const actions = useWorkflowActions();
  const { workflow, editable, model } = useEditor();
  const [asking, setAsking] = useState(false);
  const reasonId = useId();
  const elapsed = useRunElapsed(runLive ? run : null);

  const name =
    (typeof workflow?.name === 'string' && workflow.name.trim()) ||
    doc?.fileName.replace(/\.workflow\.ya?ml$/i, '') ||
    'Workflow';
  const running = runLive && run?.status === 'running';
  const errorCount = doc?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
  const blocker = doc
    ? runBlocker(trusted, doc.valid, doc.workflow !== null, Math.max(1, errorCount), model.entries.length)
    : 'Loading the workflow…';
  const inputs = declaredInputs(doc?.workflow?.inputs);

  const start = () => {
    if (blocker) return;
    if (inputs.length) setAsking(true);
    else actions.run({});
  };

  return (
    <header className="wf-topbar">
      <div className="wf-topbar__identity">
        <NameEditor
          name={name}
          editable={editable}
          onRename={(value) => actions.applyOps([{ op: 'updateWorkflow', set: { name: value } }])}
        />
        {doc ? (
          <span className="wf-topbar__file" title={doc.uri}>
            {doc.fileName}
          </span>
        ) : null}
        {doc ? <ValidationPill diagnostics={doc.diagnostics} valid={doc.valid} /> : null}
      </div>
      <div className="wf-topbar__actions">
        <RunsMenu elapsed={elapsed} />
        <Button variant="ghost" icon="go-to-file" onClick={() => actions.openYaml()}>
          Open YAML
        </Button>
        {running ? (
          <>
            <span className="wf-elapsed" aria-label="Elapsed time" role="timer">
              {formatDuration(elapsed)}
            </span>
            <Button variant="danger" icon="debug-stop" onClick={actions.cancelRun}>
              Stop
            </Button>
          </>
        ) : (
          <span className="wf-topbar__run" title={blocker ?? undefined}>
            <Button
              variant="run"
              icon="play"
              disabled={blocker !== null}
              aria-describedby={blocker ? reasonId : undefined}
              onClick={start}
            >
              Run
            </Button>
            {blocker ? (
              <span id={reasonId} className="if-visually-hidden">
                {blocker}
              </span>
            ) : null}
          </span>
        )}
      </div>
      {asking && doc ? (
        <InputsDialog
          workflowName={name}
          uri={doc.uri}
          inputs={inputs}
          onClose={() => setAsking(false)}
          onRun={(values) => {
            setAsking(false);
            actions.run(values);
          }}
        />
      ) : null}
    </header>
  );
}
