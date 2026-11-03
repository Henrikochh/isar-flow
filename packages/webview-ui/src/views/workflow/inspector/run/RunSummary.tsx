import { useMemo } from 'react';
import type { RunView, Workflow } from '@isar-flow/core';
import { Banner, Button, Chip, SimulatedChip, StatusGlyph, statusLabel } from '../../../../components';
import { formatCost, formatDuration, formatRelativeTime, formatTokens } from '../../../../hooks';
import { blockTrends, COST_TITLE, runCost } from '../../metrics';
import { ReportActions } from '../../report/ReportActions';
import { useWorkflowActions, useWorkflowState } from '../../store';
import { useNow } from '../useNow';
import { BlockTable } from './BlockTable';
import { RunOriginNote } from './RunOriginNote';
import { TrendTable } from './TrendTable';

function formatInput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Shown when a run is on the canvas and no block is selected: how the run went, block by block. */
export function RunSummary({ run, live, workflow }: { run: RunView; live: boolean; workflow: Workflow }) {
  const actions = useWorkflowActions();
  const { approvals, asks, catalog, history } = useWorkflowState();
  const running = run.status === 'running';
  const waiting = running && approvals.some((a) => a.runId === run.runId);
  const asking = running && asks.some((a) => a.runId === run.runId);
  const now = useNow(running);
  const duration = running ? (now >= run.startedAt ? now - run.startedAt : undefined) : run.durationMs;
  const inputs = Object.entries(run.inputs ?? {});
  const totalTokens = run.usage.inputTokens + run.usage.outputTokens;
  const cost = useMemo(() => runCost(run, catalog.prices), [run, catalog.prices]);
  const trends = useMemo(() => blockTrends(history), [history]);

  return (
    <div className="wf-insp-form">
      <div className="wf-run-hero" data-status={run.status}>
        <span className="wf-run-hero-glyph">
          <StatusGlyph status={run.status} />
        </span>
        <div className="wf-run-hero-text">
          <h2 className="wf-run-hero-title if-display">
            {waiting ? 'Waiting for approval' : asking ? 'Waiting for your answer' : statusLabel(run.status)}
          </h2>
          <div className="wf-run-hero-meta">
            {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
            <span>
              {live
                ? running
                  ? 'Live run'
                  : 'Latest run'
                : `Started ${formatRelativeTime(run.startedAt, now)}`}
            </span>
            {run.simulated ? <SimulatedChip /> : null}
          </div>
        </div>
        {live ? null : (
          <Button size="s" variant="ghost" icon="close" onClick={() => actions.selectRun(null)}>
            Close
          </Button>
        )}
      </div>

      <RunOriginNote run={run} />
      <ReportActions run={run} />

      {totalTokens > 0 ? (
        <div className="wf-insp-chips wf-run-totals">
          <Chip
            tone="outline"
            icon="arrow-up"
            title="Input tokens"
          >{`${formatTokens(run.usage.inputTokens)} in`}</Chip>
          <Chip
            tone="outline"
            icon="arrow-down"
            title="Output tokens"
          >{`${formatTokens(run.usage.outputTokens)} out`}</Chip>
          {cost.cost !== undefined ? (
            <Chip tone="outline" title={COST_TITLE}>{`Cost ${formatCost(cost.cost)}`}</Chip>
          ) : null}
          {cost.unpriced.length > 0 && Object.keys(catalog.prices ?? {}).length > 0 ? (
            <span
              className="wf-run-unpriced"
              title={`No price for ${cost.unpriced.join(', ')}. Add ${cost.unpriced.length === 1 ? 'it' : 'them'} to isarFlow.modelPrices.`}
            >
              {cost.unpriced.length === 1
                ? '1 model without price'
                : `${cost.unpriced.length} models without price`}
            </span>
          ) : null}
        </div>
      ) : null}

      {run.error ? (
        <Banner tone="error" title="The run failed">
          <span className="wf-insp-pre">{run.error}</span>
        </Banner>
      ) : null}

      {inputs.length ? (
        <div className="wf-insp-subsection">
          <div className="wf-insp-subtitle">Inputs</div>
          <dl className="wf-run-inputs">
            {inputs.map(([name, value]) => (
              <div key={name} className="wf-run-input">
                <dt className="wf-run-input-name">{name}</dt>
                <dd className="wf-run-input-value">{formatInput(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <BlockTable run={run} workflow={workflow} />
      <TrendTable trends={trends} workflow={workflow} />
    </div>
  );
}
