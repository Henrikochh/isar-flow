import { listBlocks, type RunView, type StepStatus, type Workflow } from '@isar-flow/core';
import { Banner, Button, Chip, Stone, StatusGlyph, statusLabel } from '../../../../components';
import { formatDuration, formatRelativeTime, formatTokens } from '../../../../hooks';
import { useWorkflowActions, useWorkflowState } from '../../store';
import { blockTitle, isStepType } from '../model';
import { useNow } from '../useNow';

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
  const { approvals } = useWorkflowState();
  const running = run.status === 'running';
  const waiting = running && approvals.some((a) => a.runId === run.runId);
  const now = useNow(running);
  const duration = running ? (now >= run.startedAt ? now - run.startedAt : undefined) : run.durationMs;
  const inputs = Object.entries(run.inputs ?? {});
  const totalTokens = run.usage.inputTokens + run.usage.outputTokens;

  return (
    <div className="wf-insp-form">
      <div className="wf-run-hero" data-status={run.status}>
        <span className="wf-run-hero-glyph">
          <StatusGlyph status={run.status} />
        </span>
        <div className="wf-run-hero-text">
          <h2 className="wf-run-hero-title if-display">{waiting ? 'Waiting for approval' : statusLabel(run.status)}</h2>
          <div className="wf-run-hero-meta">
            {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
            <span>{live ? (running ? 'Live run' : 'Latest run') : `Started ${formatRelativeTime(run.startedAt, now)}`}</span>
          </div>
        </div>
        {live ? null : (
          <Button size="s" variant="ghost" icon="close" onClick={() => actions.selectRun(null)}>
            Close
          </Button>
        )}
      </div>

      {totalTokens > 0 ? (
        <div className="wf-insp-chips">
          <Chip tone="outline" icon="arrow-up" title="Input tokens">{`${formatTokens(run.usage.inputTokens)} in`}</Chip>
          <Chip tone="outline" icon="arrow-down" title="Output tokens">{`${formatTokens(run.usage.outputTokens)} out`}</Chip>
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

      <div className="wf-insp-subsection">
        <div className="wf-insp-subtitle">Blocks</div>
        <RunRiver run={run} workflow={workflow} />
      </div>
    </div>
  );
}

/** Blocks in document order on a thin river, each with its status; click selects the block. */
function RunRiver({ run, workflow }: { run: RunView; workflow: Workflow }) {
  const actions = useWorkflowActions();
  const blocks = listBlocks(workflow);
  return (
    <ol className="wf-run-river" aria-label="Blocks in this run">
      {blocks.map((block) => {
        const id = block.id;
        const stepRun = id ? run.steps[id] : undefined;
        const status: StepStatus = stepRun?.status ?? 'pending';
        const type = isStepType(block.step.type) ? block.step.type : undefined;
        const reached = status !== 'pending' && status !== 'skipped';
        return (
          <li
            key={block.path.join('.')}
            className={reached ? 'wf-run-river-item' : 'wf-run-river-item wf-run-river-item--quiet'}
            data-status={status}
          >
            <button
              type="button"
              className="wf-run-river-row"
              disabled={!id}
              onClick={() => id && actions.select(id)}
              aria-label={`${blockTitle(block.step) || 'Block without id'}: ${statusLabel(status)}`}
            >
              <span className="wf-run-river-glyph">
                <StatusGlyph status={status} />
              </span>
              <span className="wf-run-river-body" style={{ paddingLeft: block.ancestors.length * 14 }}>
                {type ? <Stone type={type} size="s" /> : null}
                <span className="wf-run-river-title">{blockTitle(block.step) || 'Block without id'}</span>
                {stepRun && stepRun.executions > 1 ? <span className="wf-run-river-count">{`×${stepRun.executions}`}</span> : null}
              </span>
              <span className="wf-run-river-time">
                {stepRun?.durationMs !== undefined && status !== 'skipped' ? formatDuration(stepRun.durationMs) : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
