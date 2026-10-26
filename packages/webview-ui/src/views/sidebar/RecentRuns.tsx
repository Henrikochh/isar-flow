import type { RunRecordSummary } from '@isar-flow/core';
import { Section, StatusGlyph } from '../../components';
import { formatDuration, formatRelativeTime } from '../../hooks';
import { send, uniqueKeys } from './model';

const MAX_RUNS = 10;

/** Latest runs as a short stretch of river: each run's status sits on the stream like a stone. */
export function RecentRuns({ runs, now }: { runs: readonly RunRecordSummary[]; now: number }) {
  const shown = runs.slice(0, MAX_RUNS);
  const keys = uniqueKeys(shown, (run) => run.runId);
  return (
    <Section title="Recent runs">
      {shown.length === 0 ? (
        <p className="sb-note">Runs appear here after you start a workflow.</p>
      ) : (
        <ol className="sb-runs" aria-label="Recent runs">
          {shown.map((run, index) => (
            <li key={keys[index]} className="sb-run">
              <button
                type="button"
                className="sb-run__main"
                title={run.error || undefined}
                onClick={() => send({ type: 'openRun', runId: run.runId, workflowUri: run.workflowUri })}
              >
                <span className="sb-run__stone">
                  <StatusGlyph status={run.status} />
                </span>
                <span className="sb-run__name">{run.workflowName || 'Unnamed workflow'}</span>
                <span className="sb-run__meta">
                  {run.status === 'running' ? <span>Running</span> : run.durationMs !== undefined ? <span>{formatDuration(run.durationMs)}</span> : null}
                  <span>{formatRelativeTime(run.startedAt, now)}</span>
                </span>
                {run.error ? <span className="sb-run__error">{run.error}</span> : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
