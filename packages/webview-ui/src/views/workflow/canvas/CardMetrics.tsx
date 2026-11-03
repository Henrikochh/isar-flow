/**
 * Quiet last row of a card once the block finished in the shown run: time, tokens and the estimated cost. A block
 * that the last loop iteration skipped keeps the numbers of the iterations it ran in.
 */
import type { StepStatus } from '@isar-flow/core';
import { formatCost, formatDuration, formatTokens } from '../../../hooks';
import { blockNumbers, COST_TITLE, estimateCost, type BlockNumbers, totalTokens } from '../metrics';
import { useCanvas } from './canvasContext';
import type { BlockEntry } from './model';

const FINISHED: ReadonlySet<StepStatus | undefined> = new Set(['success', 'failure', 'cancelled', 'skipped']);

const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Tooltip lines: what the row has no room for. */
function details(numbers: BlockNumbers): string {
  return [
    numbers.model ? `Model ${numbers.model}` : undefined,
    numbers.turns !== undefined ? counted(numbers.turns, 'turn') : undefined,
    numbers.toolCalls !== undefined ? counted(numbers.toolCalls, 'tool call') : undefined,
    numbers.executions > 1 ? `Ran ${numbers.executions} times` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

export function CardMetrics({ entry, status }: { entry: BlockEntry; status: StepStatus | undefined }) {
  const { run, prices } = useCanvas();
  // A simulated run executed nothing, so its times and costs mean nothing.
  if (!run || run.simulated || !entry.id || !FINISHED.has(status)) return null;
  const numbers = blockNumbers(run.steps[entry.id]);
  if (!numbers) return null;
  const tokens = totalTokens(numbers);
  if (numbers.durationMs === undefined && !tokens) return null;
  const cost = estimateCost(numbers, numbers.model, prices);
  return (
    <div className="wf-card__metrics" title={details(numbers) || undefined}>
      {numbers.durationMs !== undefined ? (
        <span className="wf-card__metric">
          <i className="codicon codicon-clock" aria-hidden="true" />
          {formatDuration(numbers.durationMs)}
        </span>
      ) : null}
      {tokens ? <span className="wf-card__metric">{`${formatTokens(tokens)} tokens`}</span> : null}
      {cost !== undefined ? (
        <span className="wf-card__metric" title={COST_TITLE}>{`Cost ${formatCost(cost)}`}</span>
      ) : null}
    </div>
  );
}
