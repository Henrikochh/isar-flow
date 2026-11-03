/** "Run from here" under the status line of a block's run output: continues the shown run at this block. */
import { useId } from 'react';
import type { RunView } from '@isar-flow/core';
import { Button } from '../../../../components';
import { runFromHereState } from '../../runFromHere/model';
import { useWorkflowActions, useWorkflowState } from '../../store';

export function RunFromHereButton({ run, stepId }: { run: RunView; stepId: string }) {
  const { trusted, doc } = useWorkflowState();
  const { requestResume } = useWorkflowActions();
  const reasonId = useId();
  const state = runFromHereState(run, trusted, doc?.valid ?? false, stepId);
  const reason = state.ok ? undefined : state.reason;
  return (
    <span className="wf-run-resume" title={reason}>
      <Button
        size="s"
        variant="secondary"
        icon="run-below"
        disabled={reason !== undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => requestResume(run.runId, stepId)}
      >
        Run from here
      </Button>
      {reason ? (
        <span id={reasonId} className="if-visually-hidden">
          {reason}
        </span>
      ) : null}
    </span>
  );
}
