import './runHistory.css';
import type { RunRecordSummary } from '@isar-flow/core';
import { StatusGlyph, statusLabel } from '../../../../components';
import { formatDuration, formatRelativeTime, formatTokens } from '../../../../hooks';
import { ReviewCounts } from '../../review/ReviewCounts';
import { useWorkflowActions, useWorkflowState } from '../../store';

/** Past runs of this workflow; clicking one shows it on the canvas. */
export function RunHistory() {
  const { history, run } = useWorkflowState();
  const actions = useWorkflowActions();
  if (history.length === 0) {
    return <p className="wf-insp-note">No runs yet. Each run of this workflow appears here.</p>;
  }
  const now = Date.now();
  return (
    <ul className="wf-history" aria-label="Run history">
      {history.map((record: RunRecordSummary) => {
        const current = run?.runId === record.runId;
        const tokens = record.usage ? record.usage.inputTokens + record.usage.outputTokens : 0;
        return (
          <li key={record.runId}>
            <button
              type="button"
              className={current ? 'wf-history-row wf-history-row--current' : 'wf-history-row'}
              aria-current={current || undefined}
              onClick={() => actions.selectRun(record.runId)}
            >
              <StatusGlyph status={record.status} />
              <span className="wf-history-main">
                <span className="wf-history-line">
                  <span className="wf-history-status">{statusLabel(record.status)}</span>
                  <span className="wf-history-when">{formatRelativeTime(record.startedAt, now)}</span>
                </span>
                {record.error ? <span className="wf-history-error">{record.error}</span> : null}
                {record.review?.total ? (
                  <span className="wf-history-review">
                    <ReviewCounts counts={record.review} />
                  </span>
                ) : null}
              </span>
              <span className="wf-history-meta">
                {record.durationMs !== undefined ? <span>{formatDuration(record.durationMs)}</span> : null}
                {tokens > 0 ? <span>{`${formatTokens(tokens)} tokens`}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
