import { Fragment, useRef, useState } from 'react';
import { collectStepIds, type RunRecordSummary, type Workflow } from '@isar-flow/core';
import {
  Menu,
  MenuItem,
  MenuLabel,
  Popover,
  RunOriginChip,
  StatusGlyph,
  statusLabel,
} from '../../../components';
import { formatDuration, formatRelativeTime } from '../../../hooks';
import { ReviewCounts } from '../review/ReviewCounts';
import { blockName, startBlocker } from '../runFromHere/model';
import { useWorkflowActions, useWorkflowState } from '../store';

/** The block a failed or cancelled run stopped at, when "Run from <block>" applies to it in this workflow. */
function resumableAt(record: RunRecordSummary, workflow: Workflow | null): string | undefined {
  if (record.simulated || (record.status !== 'failure' && record.status !== 'cancelled')) return undefined;
  const stepId = record.stoppedAt;
  return typeof stepId === 'string' && collectStepIds(workflow).includes(stepId) ? stepId : undefined;
}

/** Shows which run is on the canvas and lets the user switch between the live run and past runs. */
export function RunsMenu({ elapsed }: { elapsed: number | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const { run, runLive, history, doc, trusted } = useWorkflowState();
  const { selectRun, requestResume } = useWorkflowActions();
  const workflow = doc?.workflow ?? null;
  const live = runLive && run?.status === 'running' ? run : null;
  const nameOf = (id: string) => blockName(workflow, id);
  const resumeBlocker = startBlocker(trusted, doc?.valid ?? false);
  const choose = (runId: string | null) => {
    setOpen(false);
    selectRun(runId);
  };
  const resume = (runId: string, stepId: string) => {
    // Back on the button first, so the dialog that follows returns the focus there.
    ref.current?.focus();
    setOpen(false);
    requestResume(runId, stepId);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="wf-runs"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Run history"
        onClick={() => setOpen((o) => !o)}
      >
        {run ? (
          <>
            <StatusGlyph status={run.status} />
            <span>{runLive && run.status === 'running' ? 'Live run' : statusLabel(run.status)}</span>
            {run.status !== 'running' && run.durationMs !== undefined ? (
              <span className="wf-runs__muted">{formatDuration(run.durationMs)}</span>
            ) : null}
            <RunOriginChip run={run} blockName={nameOf} />
          </>
        ) : (
          <>
            <i className="codicon codicon-history wf-runs__icon" aria-hidden="true" />
            <span>Runs</span>
          </>
        )}
        <i className="codicon codicon-chevron-down wf-runs__chevron" aria-hidden="true" />
      </button>
      <Popover
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        label="Runs"
        role="none"
        placement="bottom-end"
        width={300}
      >
        <Menu label="Runs">
          {live ? (
            <MenuItem
              leading={<StatusGlyph status="running" />}
              meta={formatDuration(elapsed)}
              current={run === live}
              onSelect={() => choose(null)}
            >
              Live run
            </MenuItem>
          ) : null}
          {history.length ? <MenuLabel>History</MenuLabel> : null}
          {history.map((record) => {
            const stoppedAt = resumableAt(record, workflow);
            return (
              <Fragment key={record.runId}>
                <MenuItem
                  leading={<StatusGlyph status={record.status} />}
                  description={
                    record.error || record.review?.total ? (
                      <span className="wf-runs__desc">
                        <ReviewCounts counts={record.review} />
                        {record.error ? <span className="wf-runs__error">{record.error}</span> : null}
                      </span>
                    ) : undefined
                  }
                  meta={formatDuration(record.durationMs)}
                  current={run?.runId === record.runId}
                  title={`${statusLabel(record.status)} ${new Date(record.startedAt).toLocaleString()}`}
                  onSelect={() => choose(record.runId)}
                >
                  <span className="wf-runs__when">
                    <span>{formatRelativeTime(record.startedAt)}</span>
                    <RunOriginChip run={record} blockName={nameOf} />
                  </span>
                </MenuItem>
                {stoppedAt ? (
                  <MenuItem
                    indent
                    leading={<i className="codicon codicon-run-below" aria-hidden="true" />}
                    disabled={resumeBlocker !== undefined}
                    description={resumeBlocker}
                    wrap={resumeBlocker !== undefined}
                    onSelect={() => resume(record.runId, stoppedAt)}
                  >
                    {`Run from ${nameOf(stoppedAt)}`}
                  </MenuItem>
                ) : null}
              </Fragment>
            );
          })}
          {!live && !history.length ? (
            <div className="wf-runs__empty">No runs yet. Runs of this workflow show up here.</div>
          ) : null}
        </Menu>
      </Popover>
    </>
  );
}
