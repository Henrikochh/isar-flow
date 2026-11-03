/**
 * Finishes a "Run from here" request (store `resumeRequest`) once its run is on the canvas: starts the run at once
 * when there is nothing to ask, else shows the "Run from <block>" dialog with the inputs of that run and the notes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { InputsDialog } from '../topbar/InputsDialog';
import { type ResumeRequest, useWorkflowActions, useWorkflowState } from '../store';
import { blockName } from './model';
import { planResume } from './plan';

export function RunFromHereHost({ workflowName }: { workflowName: string }) {
  const { resumeRequest, run, doc, trusted, history } = useWorkflowState();
  const actions = useWorkflowActions();
  const request = resumeRequest && run?.runId === resumeRequest.runId ? resumeRequest : null;
  const workflow = doc?.workflow ?? null;
  const valid = doc?.valid ?? false;
  const record = history.find((r) => r.runId === request?.runId);

  const plan = useMemo(
    () =>
      request && run ? planResume({ workflow, run, stepId: request.stepId, trusted, valid, record }) : null,
    [request, run, workflow, trusted, valid, record],
  );

  // Once the dialog is shown for a request, only the user starts the run: an edit that clears the last warning
  // while it is open must not start it behind the dialog.
  const [askedFor, setAskedFor] = useState<ResumeRequest | null>(null);
  const asked = request !== null && askedFor === request;
  useEffect(() => {
    if (request && plan?.kind === 'ask' && askedFor !== request) setAskedFor(request);
  }, [plan, request, askedFor]);

  // A request starts at most once, even when the state changes again before the run starts.
  const started = useRef<ResumeRequest | null>(null);
  useEffect(() => {
    if (!request || !run || plan?.kind !== 'start' || asked || started.current === request) return;
    started.current = request;
    actions.clearResumeRequest();
    actions.runFromHere(request.runId, request.stepId, run.inputs ?? {});
  }, [plan, request, run, actions, asked]);

  if (!request || !run || !doc || !plan || (plan.kind !== 'ask' && !asked)) return null;
  const shown = plan.kind === 'ask' ? plan : { inputs: [], notes: plan.notes, blocker: undefined };
  return (
    <InputsDialog
      key={`${request.runId}:${request.stepId}`}
      mode="resume"
      workflowName={workflowName}
      blockName={blockName(workflow, request.stepId)}
      uri={doc.uri}
      inputs={shown.inputs}
      values={run.inputs ?? {}}
      notes={shown.notes}
      blocker={shown.blocker}
      onClose={actions.clearResumeRequest}
      onRun={(values) => {
        actions.clearResumeRequest();
        actions.runFromHere(request.runId, request.stepId, values);
      }}
    />
  );
}
