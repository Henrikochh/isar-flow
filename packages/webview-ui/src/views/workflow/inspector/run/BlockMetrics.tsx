/** Run output of a block: its totals in this run and its averages over the latest runs. */
import { useMemo } from 'react';
import type { StepRunView } from '@isar-flow/core';
import { formatCost, formatDuration, formatTokens } from '../../../../hooks';
import {
  blockNumbers,
  blockTrends,
  COST_TITLE,
  estimateCost,
  formatAverage,
  trendsLabel,
  type BlockTrend,
} from '../../metrics';
import { useWorkflowState } from '../../store';

/** "Last 6 runs: 1 m 4 s, 3.1k tokens on average". */
function trendLine(runs: number, trend: BlockTrend): string {
  const parts = [formatDuration(trend.durationMs)];
  if (trend.tokens) parts.push(`${formatTokens(Math.round(trend.tokens))} tokens`);
  if (trend.iterations !== undefined) {
    const value = formatAverage(trend.iterations);
    parts.push(`${value} ${value === '1' ? 'iteration' : 'iterations'}`);
  }
  return `${trendsLabel(runs)}: ${parts.join(', ')} on average`;
}

export function BlockMetrics({ stepId, stepRun }: { stepId: string; stepRun: StepRunView }) {
  const { catalog, history } = useWorkflowState();
  const trends = useMemo(() => blockTrends(history), [history]);
  const trend = trends && Object.hasOwn(trends.blocks, stepId) ? trends.blocks[stepId] : undefined;
  const numbers = stepRun.status === 'running' ? undefined : blockNumbers(stepRun);
  const hasTokens = numbers?.inputTokens !== undefined && numbers.outputTokens !== undefined;
  const cost = numbers ? estimateCost(numbers, numbers.model, catalog.prices) : undefined;
  const repeated = numbers !== undefined && numbers.executions > 1;
  // A single execution's time is already in the status line; the list adds what it does not say.
  const worth =
    numbers !== undefined &&
    (hasTokens ||
      repeated ||
      numbers.turns !== undefined ||
      numbers.toolCalls !== undefined ||
      numbers.model !== undefined);

  return (
    <>
      {worth && numbers ? (
        <div role="group" aria-label="Time and tokens">
          <dl className="wf-run-metrics">
            {numbers.durationMs !== undefined ? (
              <div className="wf-run-metric">
                <dt>Time</dt>
                <dd>
                  <span>{formatDuration(numbers.durationMs)}</span>
                  {repeated ? (
                    <span className="wf-run-metric-muted">{`${formatDuration(numbers.durationMs / numbers.executions)} each`}</span>
                  ) : null}
                </dd>
              </div>
            ) : null}
            {hasTokens ? (
              <div className="wf-run-metric">
                <dt>Tokens</dt>
                <dd>
                  <span title="Input tokens">{`${formatTokens(numbers.inputTokens ?? 0)} in`}</span>
                  <span title="Output tokens">{`${formatTokens(numbers.outputTokens ?? 0)} out`}</span>
                </dd>
              </div>
            ) : null}
            {numbers.turns !== undefined ? (
              <div className="wf-run-metric">
                <dt>Turns</dt>
                <dd>{numbers.turns}</dd>
              </div>
            ) : null}
            {numbers.toolCalls !== undefined ? (
              <div className="wf-run-metric">
                <dt>Tool calls</dt>
                <dd>{numbers.toolCalls}</dd>
              </div>
            ) : null}
            {numbers.model ? (
              <div className="wf-run-metric">
                <dt>Model</dt>
                <dd>
                  <code className="wf-run-metric-code" title={numbers.model}>
                    {numbers.model}
                  </code>
                </dd>
              </div>
            ) : null}
            {cost !== undefined ? (
              <div className="wf-run-metric">
                <dt>Cost</dt>
                <dd title={COST_TITLE}>{formatCost(cost)}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
      {trend && trends ? <p className="wf-insp-note">{trendLine(trends.runs, trend)}</p> : null}
    </>
  );
}
