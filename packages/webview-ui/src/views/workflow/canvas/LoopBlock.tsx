/** Loop container: a frame on the river with a header and an eddy (return channel) on its left side. */
import { formatDuration } from '../../../hooks';
import { blockNumbers } from '../metrics';
import { useCanvas } from './canvasContext';
import { CardBadge, TypeStone } from './BlockCard';
import { BreakableCode } from './BreakableCode';
import { type BlockEntry, textOf } from './model';
import { cx } from '../cx';
import { RiverList } from './River';
import { loopProgress } from './runOverlay';
import { loopSummary } from './summaries';
import { useBlockHandle } from './useBlockHandle';

type EddyState = 'idle' | 'passed' | 'pending';

/** Return channel drawn from the bottom of the frame back up to the header, ending in an arrowhead. */
function Eddy({ state, iteration, label }: { state: EddyState; iteration?: number; label?: string }) {
  return (
    <div className={cx('wf-eddy', `wf-eddy--${state}`)} aria-hidden="true">
      <svg className="wf-eddy__cap" width="28" height="18" viewBox="0 0 28 18">
        <path d="M9 18 V12 Q9 4 17 4 H25" />
        <path d="M21 0.5 L25.5 4 L21 7.5" />
      </svg>
      <span className="wf-eddy__channel" />
      {iteration !== undefined ? (
        <span className="wf-eddy__badge" title={label}>
          {iteration}
        </span>
      ) : null}
      <span className="wf-eddy__channel" />
      <svg className="wf-eddy__cap" width="28" height="18" viewBox="0 0 28 18">
        <path d="M27 14 H17 Q9 14 9 6 V0" />
      </svg>
    </div>
  );
}

export function LoopBlock({ entry }: { entry: BlockEntry }) {
  const handle = useBlockHandle(entry);
  const { run, select } = useCanvas();
  const step = entry.step as unknown as Record<string, unknown>;
  const summary = loopSummary(step);
  const max = typeof step.maxIterations === 'number' ? step.maxIterations : undefined;
  const progress = loopProgress(run, entry);
  const running = run?.status === 'running' && handle.status === 'running';
  const name = textOf(step.name).trim();
  const body = entry.children[0];
  const progressLabel = progress
    ? progress.running
      ? `Iteration ${progress.iteration} of ${progress.maxIterations}`
      : `Ran ${progress.iteration} ${progress.iteration === 1 ? 'time' : 'times'}`
    : undefined;
  const eddy: EddyState = !run ? 'idle' : progress && progress.iteration > 1 ? 'passed' : 'pending';
  const duration =
    progress && !progress.running && entry.id ? blockNumbers(run?.steps[entry.id])?.durationMs : undefined;

  return (
    <div
      className={cx(
        'wf-loop',
        entry.parent && 'wf-loop--nested',
        handle.selected && 'wf-loop--selected',
        handle.dragging && 'wf-loop--dragging',
        running && 'wf-loop--running',
        handle.status === 'skipped' && 'wf-loop--skipped',
      )}
      data-type="loop"
      role="group"
      aria-label={`Loop ${handle.title}`}
      onClick={(event) => {
        event.stopPropagation();
        if (entry.id) select(entry.id);
      }}
    >
      <Eddy
        state={eddy}
        iteration={progress && progress.iteration > 1 ? progress.iteration : undefined}
        label={progressLabel}
      />
      <div {...handle.props} className="wf-loop__head">
        <div className="wf-loop__lead">
          <TypeStone entry={entry} />
          <div className="wf-loop__titles">
            <div className="wf-loop__title-row">
              <span className="wf-loop__title" title={handle.title}>
                {handle.title}
              </span>
              {name && entry.id ? <code className="wf-card__id">{entry.id}</code> : null}
            </div>
            <div
              className="wf-loop__summary"
              title={summary.condition ? `${summary.lead} ${summary.condition}` : undefined}
            >
              {summary.lead}
              {summary.condition ? (
                <>
                  {' '}
                  <BreakableCode className="wf-loop__cond" text={summary.condition} />
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div className="wf-loop__aside">
          {progressLabel ? (
            <span
              className={cx('wf-iter', progress?.running && 'wf-iter--live')}
              title={duration !== undefined ? `${progressLabel} in ${formatDuration(duration)}` : undefined}
            >
              {progressLabel}
            </span>
          ) : max !== undefined && summary.condition ? (
            // Loops without a condition already say "Repeat N times"; the limit only adds to a condition.
            <span
              className="wf-iter wf-iter--limit"
              title={max === 1 ? 'Runs at most once' : `Repeats at most ${max} times`}
            >
              max {max}
            </span>
          ) : null}
          <CardBadge entry={entry} status={handle.status} />
        </div>
      </div>
      <div className="wf-loop__body">{body ? <RiverList list={body} owner={entry} /> : null}</div>
    </div>
  );
}
