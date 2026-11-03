/** Quiet note in the run summary: the run continued an earlier one, or was simulated. */
import type { RunView } from '@isar-flow/core';
import { Button } from '../../../../components';
import { blockName, sourceRunLabel } from '../../runFromHere/model';
import { simulatedNote } from '../../simulation/copy';
import { useWorkflowActions, useWorkflowState } from '../../store';

export function RunOriginNote({ run }: { run: RunView }) {
  const { history, doc } = useWorkflowState();
  const actions = useWorkflowActions();
  if (run.simulated) {
    return (
      <p className="wf-run-origin">
        <i className="codicon codicon-beaker wf-run-origin__icon" aria-hidden="true" />
        <span>
          {`${simulatedNote(run.status === 'running')} `}
          <Button variant="link" onClick={actions.openSimulationFile}>
            Edit mocks
          </Button>
        </span>
      </p>
    );
  }
  const from = run.resumedFrom;
  if (!from) return null;
  const source = sourceRunLabel(run, history);
  const block = blockName(doc?.workflow, from.stepId);
  return (
    <p className="wf-run-origin">
      <i className="codicon codicon-run-below wf-run-origin__icon" aria-hidden="true" />
      <span>
        {`Resumed from ${block} of ${source ?? 'an earlier run'}. `}
        {source ? (
          <Button variant="link" onClick={() => actions.selectRun(from.runId)}>
            Show that run
          </Button>
        ) : null}
      </span>
    </p>
  );
}
