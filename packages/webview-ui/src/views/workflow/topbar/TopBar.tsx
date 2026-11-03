/** Top bar of the workflow editor: name, file, validation, runs, Open YAML and Run (with Simulate) / Stop. */
import './topbar.css';
import { useEffect, useState } from 'react';
import { Button, SplitButton } from '../../../components';
import { formatDuration } from '../../../hooks';
import { useEditor } from '../editorContext';
import { RunFromHereHost } from '../runFromHere/RunFromHereHost';
import { type StartMode, useWorkflowActions, useWorkflowState } from '../store';
import { declaredInputs, InputsDialog } from './InputsDialog';
import { NameEditor } from './NameEditor';
import { RunsMenu } from './RunsMenu';
import { useRunControlsFocus } from './useRunControlsFocus';
import { useRunElapsed } from './useRunElapsed';
import { useStartBlockers } from './useStartBlockers';
import { ValidationPill } from './ValidationPill';

export { runBlocker } from './useStartBlockers';

export function TopBar() {
  const { doc, run, runLive, startRequest } = useWorkflowState();
  const actions = useWorkflowActions();
  const { workflow, editable } = useEditor();
  const [asking, setAsking] = useState<StartMode | null>(null);
  const elapsed = useRunElapsed(runLive ? run : null);

  const name =
    (typeof workflow?.name === 'string' && workflow.name.trim()) ||
    doc?.fileName.replace(/\.workflow\.ya?ml$/i, '') ||
    'Workflow';
  const running = runLive && run?.status === 'running';
  const runFocus = useRunControlsFocus(running);
  const { run: blocker, simulate: simulateBlocker } = useStartBlockers();
  const inputs = declaredInputs(doc?.workflow?.inputs);

  const start = (mode: StartMode) => {
    if ((mode === 'run' ? blocker : simulateBlocker) !== null) return;
    if (inputs.length) setAsking(mode);
    else if (mode === 'run') actions.run({});
    else actions.simulate({});
  };

  // Run or Simulate asked for elsewhere (the Restricted Mode banner) starts here, with the same checks and dialog.
  useEffect(() => {
    if (!startRequest) return;
    actions.clearStartRequest();
    if (!running) start(startRequest);
    // Once per request; start reads the state of the render that made it.
  }, [startRequest]);

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
        <div
          className="wf-topbar__run"
          ref={runFocus.ref}
          onFocus={runFocus.onFocus}
          onBlur={runFocus.onBlur}
        >
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
            <SplitButton
              variant="run"
              icon="play"
              disabled={blocker !== null}
              disabledReason={blocker ?? undefined}
              onClick={() => start('run')}
              moreLabel="More run options"
              moreDisabled={simulateBlocker !== null}
              moreDisabledReason={simulateBlocker ?? undefined}
              menuLabel="Run options"
              items={[
                {
                  label: 'Run',
                  icon: 'play',
                  disabled: blocker !== null,
                  description: blocker ?? undefined,
                  onSelect: () => start('run'),
                },
                {
                  label: 'Simulate',
                  icon: 'beaker',
                  description: 'Use mocks; nothing runs',
                  onSelect: () => start('simulate'),
                },
                { separator: true },
                { label: 'Edit simulation mocks', icon: 'go-to-file', onSelect: actions.openSimulationFile },
              ]}
            >
              Run
            </SplitButton>
          )}
        </div>
      </div>
      {asking && doc ? (
        <InputsDialog
          mode={asking}
          workflowName={name}
          uri={doc.uri}
          inputs={inputs}
          onClose={() => setAsking(null)}
          onRun={(values) => {
            setAsking(null);
            if (asking === 'run') actions.run(values);
            else actions.simulate(values);
          }}
        />
      ) : null}
      {doc ? <RunFromHereHost workflowName={name} /> : null}
    </header>
  );
}
