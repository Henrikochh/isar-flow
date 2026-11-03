/**
 * "Blocks in this run": every block in document order on a thin river, with status, time, tokens, the model that
 * answered (on a second line, so the numbers keep their columns at the inspector's 360 px) and how often it ran.
 */
import { useId } from 'react';
import { listBlocks, type BlockNode, type RunView, type StepStatus, type Workflow } from '@isar-flow/core';
import { Stone, StatusGlyph, statusLabel } from '../../../../components';
import { formatDuration, formatTokens } from '../../../../hooks';
import { blockNumbers, totalTokens } from '../../metrics';
import { useWorkflowActions } from '../../store';
import { blockTitle, isStepType } from '../model';

const INDENT = 14;

/** Stone and title of a block, indented by its depth. */
export function BlockName({ block }: { block: BlockNode }) {
  const type = isStepType(block.step.type) ? block.step.type : undefined;
  const title = blockTitle(block.step) || 'Block without id';
  return (
    <>
      {type ? <Stone type={type} size="s" /> : null}
      <span className="wf-run-title" title={title}>
        {title}
      </span>
    </>
  );
}

export const indentOf = (block: BlockNode) => ({ paddingLeft: block.ancestors.length * INDENT });

/** "×4": loop iterations, or executions of a block a loop ran several times. */
function repeats(iterations: number | undefined, executions: number | undefined): string {
  const count = iterations ?? (executions !== undefined && executions > 1 ? executions : undefined);
  return count === undefined ? '' : `×${count}`;
}

function BlockRow({ block, run }: { block: BlockNode; run: RunView }) {
  const actions = useWorkflowActions();
  const id = block.id;
  const view = id ? run.steps[id] : undefined;
  const status: StepStatus = view?.status ?? 'pending';
  const numbers = blockNumbers(view);
  const tokens = numbers ? totalTokens(numbers) : undefined;
  const reached = status !== 'pending' && status !== 'skipped';
  const title = blockTitle(block.step) || 'Block without id';
  return (
    <div
      role="row"
      className={reached ? 'wf-run-river-item' : 'wf-run-river-item wf-run-river-item--quiet'}
      data-status={status}
      onClick={() => id && actions.select(id)}
    >
      <span role="cell" className="wf-run-river-glyph">
        <StatusGlyph status={status} />
      </span>
      <span role="cell" className="wf-run-cell-block" style={indentOf(block)}>
        <button
          type="button"
          className="wf-run-block"
          disabled={!id}
          aria-label={`${title}: ${statusLabel(status)}`}
        >
          <BlockName block={block} />
        </button>
      </span>
      <span role="cell" className="wf-run-cell-model" style={indentOf(block)}>
        {numbers?.model ? (
          <code className="wf-run-model" title={numbers.model}>
            {numbers.model}
          </code>
        ) : view?.reused ? (
          <span className="wf-run-reused" title="Not run: the result comes from the run this one continues.">
            <i className="codicon codicon-history" aria-hidden="true" />
            Reused
          </span>
        ) : null}
      </span>
      <span role="cell" className="wf-run-cell-num">
        {numbers?.durationMs !== undefined && status !== 'running' ? formatDuration(numbers.durationMs) : ''}
      </span>
      <span role="cell" className="wf-run-cell-num">
        {tokens ? formatTokens(tokens) : ''}
      </span>
      <span role="cell" className="wf-run-cell-num">
        {repeats(numbers?.iterations ?? view?.loop?.iteration, numbers?.executions ?? view?.executions)}
      </span>
    </div>
  );
}

/** Column headers shared by the run table and the trends table; `model` adds the hidden Model column. */
export function TableHead({ status, model }: { status?: boolean; model?: boolean }) {
  return (
    <div role="rowgroup">
      <div role="row" className={status ? 'wf-run-head' : 'wf-run-head wf-run-head--plain'}>
        {status ? (
          <span role="columnheader" className="wf-run-cell-status">
            <span className="if-visually-hidden">Status</span>
          </span>
        ) : null}
        <span role="columnheader" className="wf-run-cell-block">
          Block
        </span>
        {model ? (
          <span role="columnheader" className="if-visually-hidden">
            Model
          </span>
        ) : null}
        <span role="columnheader" className="wf-run-cell-num">
          Time
        </span>
        <span role="columnheader" className="wf-run-cell-num">
          Tokens
        </span>
        <span role="columnheader" className="wf-run-cell-num">
          <span className="if-visually-hidden">Iterations</span>
        </span>
      </div>
    </div>
  );
}

export function BlockTable({ run, workflow }: { run: RunView; workflow: Workflow }) {
  const titleId = useId();
  const blocks = listBlocks(workflow);
  return (
    <div className="wf-insp-subsection">
      <div className="wf-insp-subtitle" id={titleId}>
        Blocks in this run
      </div>
      <div role="table" aria-labelledby={titleId} className="wf-run-table">
        <TableHead status model />
        <div role="rowgroup">
          {blocks.map((block) => (
            <BlockRow key={block.path.join('.')} block={block} run={run} />
          ))}
        </div>
      </div>
    </div>
  );
}
