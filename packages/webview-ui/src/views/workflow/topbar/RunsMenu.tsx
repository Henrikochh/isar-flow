import { useRef, useState } from 'react';
import { Menu, MenuItem, MenuLabel, Popover, StatusGlyph, statusLabel } from '../../../components';
import { formatDuration, formatRelativeTime } from '../../../hooks';
import { ReviewCounts } from '../review/ReviewCounts';
import { useWorkflowActions, useWorkflowState } from '../store';

/** Shows which run is on the canvas and lets the user switch between the live run and past runs. */
export function RunsMenu({ elapsed }: { elapsed: number | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const { run, runLive, history } = useWorkflowState();
  const { selectRun } = useWorkflowActions();
  const live = runLive && run?.status === 'running' ? run : null;
  const choose = (runId: string | null) => {
    setOpen(false);
    selectRun(runId);
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
          {history.map((record) => (
            <MenuItem
              key={record.runId}
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
              {formatRelativeTime(record.startedAt)}
            </MenuItem>
          ))}
          {!live && !history.length ? (
            <div className="wf-runs__empty">No runs yet. Runs of this workflow show up here.</div>
          ) : null}
        </Menu>
      </Popover>
    </>
  );
}
