import type { ActiveRunSummary, RunRecordSummary } from '@isar-flow/core';
import { Chip, hasRunOriginChip, RunOriginChip, Section, StatusGlyph } from '../../components';
import { formatDuration, formatRelativeTime } from '../../hooks';
import { formatElapsed, send, uniqueKeys } from './model';

const MAX_RUNS = 10;

/** Changed files of the run that still wait for Keep or Revert. */
function pendingReviews(run: RunRecordSummary): number {
  const pending = run.review?.pending;
  return typeof pending === 'number' && Number.isFinite(pending) ? pending : 0;
}

function RunName({ name }: { name: string }) {
  const label = name || 'Unnamed workflow';
  return (
    <span className="sb-run__name" title={label}>
      {label}
    </span>
  );
}

/**
 * Latest runs as a short stretch of river: each run's status sits on the stream like a stone. Runs in progress
 * come first, then the finished ones, newest first.
 */
export function RecentRuns({
  active,
  runs,
  now,
}: {
  active: readonly ActiveRunSummary[];
  runs: readonly RunRecordSummary[];
  now: number;
}) {
  const running = [...active].sort((a, b) => b.startedAt - a.startedAt);
  const shown = runs.slice(0, MAX_RUNS);
  const keys = uniqueKeys([...running, ...shown], (run) => run.runId);
  return (
    <Section title="Recent runs">
      {running.length + shown.length === 0 ? (
        <p className="sb-note">Runs appear here after you start a workflow.</p>
      ) : (
        <ol className="sb-runs" aria-label="Recent runs">
          {running.map((run, index) => (
            <li key={keys[index]} className="sb-run">
              <button
                type="button"
                className="sb-run__main"
                onClick={() => send({ type: 'openRun', runId: run.runId, workflowUri: run.workflowUri })}
              >
                <span className="sb-run__stone">
                  <StatusGlyph status="running" />
                </span>
                <RunName name={run.workflowName} />
                <span className="sb-run__meta">
                  <span className="sb-meta-running">Running</span>
                  <span className="sb-meta-elapsed">{formatElapsed(now - run.startedAt)}</span>
                </span>
              </button>
            </li>
          ))}
          {shown.map((run, index) => (
            <li key={keys[running.length + index]} className="sb-run">
              <button
                type="button"
                className="sb-run__main"
                onClick={() => send({ type: 'openRun', runId: run.runId, workflowUri: run.workflowUri })}
              >
                <span className="sb-run__stone">
                  <StatusGlyph status={run.status} />
                </span>
                <RunName name={run.workflowName} />
                <span className="sb-run__meta">
                  {run.durationMs !== undefined ? <span>{formatDuration(run.durationMs)}</span> : null}
                  <span>{formatRelativeTime(run.startedAt, now)}</span>
                </span>
                {pendingReviews(run) > 0 || hasRunOriginChip(run) ? (
                  <span className="sb-run__review">
                    <RunOriginChip run={run} />
                    {pendingReviews(run) > 0 ? (
                      <Chip
                        tone="warning"
                        icon="diff"
                        title="Files this run changed that you have not kept or reverted"
                      >
                        {`${pendingReviews(run)} to review`}
                      </Chip>
                    ) : null}
                  </span>
                ) : null}
                {run.error ? (
                  <span className="sb-run__error" title={run.error}>
                    {run.error}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
