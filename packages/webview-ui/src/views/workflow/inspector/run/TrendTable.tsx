/** "Average of the last 20 runs": average time, tokens and iterations per block, from the run history's block numbers. */
import { useId } from 'react';
import { listBlocks, type Workflow } from '@isar-flow/core';
import { formatDuration, formatTokens } from '../../../../hooks';
import { formatAverage, trendsTitle, type WorkflowTrends } from '../../metrics';
import { BlockName, indentOf, TableHead } from './BlockTable';

export function TrendTable({ trends, workflow }: { trends: WorkflowTrends | undefined; workflow: Workflow }) {
  const titleId = useId();
  const rows = trends
    ? listBlocks(workflow).filter((block) => block.id && Object.hasOwn(trends.blocks, block.id))
    : [];
  if (!trends || rows.length === 0) {
    return (
      <div className="wf-insp-subsection">
        <div className="wf-insp-subtitle">{trendsTitle(20)}</div>
        <p className="wf-insp-note">Trends appear after two runs.</p>
      </div>
    );
  }
  return (
    <div className="wf-insp-subsection">
      <div className="wf-insp-subtitle" id={titleId}>
        {trendsTitle(trends.runs)}
      </div>
      <div role="table" aria-labelledby={titleId} className="wf-run-table">
        <TableHead />
        <div role="rowgroup">
          {rows.map((block) => {
            const trend = trends.blocks[block.id as string];
            return (
              <div
                key={block.path.join('.')}
                role="row"
                className="wf-run-trend"
                title={`Average of ${trend.runs} runs`}
              >
                <span role="cell" className="wf-run-cell-block wf-run-trend-name" style={indentOf(block)}>
                  <BlockName block={block} />
                </span>
                <span role="cell" className="wf-run-cell-num">
                  {formatDuration(trend.durationMs)}
                </span>
                <span role="cell" className="wf-run-cell-num">
                  {trend.tokens ? formatTokens(Math.round(trend.tokens)) : ''}
                </span>
                <span role="cell" className="wf-run-cell-num">
                  {trend.iterations !== undefined ? `×${formatAverage(trend.iterations)}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
