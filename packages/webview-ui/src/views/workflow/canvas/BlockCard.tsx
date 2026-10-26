/** Leaf block cards on the river (agent, console, stop, approval, break and unknown blocks). */
import type { ReactNode } from 'react';
import { Stone, StatusGlyph } from '../../../components';
import type { StepStatus } from '@isar-flow/core';
import { cx } from '../cx';
import { useCanvas } from './canvasContext';
import { CardBody } from './CardBody';
import { type BlockEntry, textOf } from './model';
import { type BlockHandle, useBlockHandle } from './useBlockHandle';

/** Status glyph during a run; otherwise a problem badge for diagnostics or a missing id. */
export function CardBadge({ entry, status }: { entry: BlockEntry; status: StepStatus | undefined }) {
  const { problems, run } = useCanvas();
  if (status && (status !== 'pending' || run?.status === 'running')) return <StatusGlyph status={status} />;
  if (!entry.id) {
    return (
      <span
        className="wf-badge wf-badge--warning"
        title="This block has no id. Choose Add ids above the canvas so it can be edited here."
      >
        <i className="codicon codicon-warning wf-badge__icon" aria-hidden="true" />
        No id
      </span>
    );
  }
  const list = problems.get(entry.id) ?? [];
  if (!list.length) return null;
  const errors = list.some((d) => d.severity === 'error');
  return (
    <span
      className={errors ? 'wf-badge wf-badge--error' : 'wf-badge wf-badge--warning'}
      title={list.map((d) => d.message).join('\n')}
      aria-label={`${list.length} ${list.length === 1 ? 'problem' : 'problems'}`}
    >
      <i className={`codicon codicon-${errors ? 'error' : 'warning'} wf-badge__icon`} aria-hidden="true" />
      {list.length}
    </span>
  );
}

export function TypeStone({ entry, size = 'm' }: { entry: BlockEntry; size?: 's' | 'm' }) {
  if (entry.type) return <Stone type={entry.type} size={size} />;
  return (
    <span className={`if-stone if-stone--${size} wf-stone-unknown`} aria-hidden="true">
      <i className="codicon codicon-question" />
    </span>
  );
}

/** Row 1 of a card: stone, title (name or id, with the id beside a name) and badge. */
export function CardHead({
  entry,
  handle,
  extra,
}: {
  entry: BlockEntry;
  handle: BlockHandle;
  extra?: ReactNode;
}) {
  const name = textOf((entry.step as { name?: unknown }).name).trim();
  return (
    <div className="wf-card__head">
      <TypeStone entry={entry} />
      <div className="wf-card__titles">
        <span className="wf-card__title" title={handle.title}>
          {handle.title}
        </span>
        {name && entry.id ? <code className="wf-card__id">{entry.id}</code> : null}
      </div>
      {extra}
      <CardBadge entry={entry} status={handle.status} />
    </div>
  );
}

/** Classes shared by every selectable surface for run and selection state. */
export function stateClasses(
  base: string,
  entry: BlockEntry,
  handle: BlockHandle,
  running: boolean,
  awaiting: boolean,
): string {
  return cx(
    base,
    handle.selected && `${base}--selected`,
    handle.dragging && `${base}--dragging`,
    running && `${base}--running`,
    awaiting && `${base}--awaiting`,
    handle.status === 'skipped' && `${base}--skipped`,
    !entry.id && `${base}--broken`,
  );
}

export function BlockCard({ entry }: { entry: BlockEntry }) {
  const handle = useBlockHandle(entry);
  const { run, awaitingApproval } = useCanvas();
  const running = run?.status === 'running' && handle.status === 'running';
  const awaiting = entry.id !== undefined && awaitingApproval.has(entry.id);

  if (entry.type === 'break') {
    return (
      <div
        {...handle.props}
        className={stateClasses('wf-pill', entry, handle, running, awaiting)}
        data-type="break"
      >
        <TypeStone entry={entry} size="s" />
        <span className="wf-pill__label">Leave loop</span>
        <CardBadge entry={entry} status={handle.status} />
      </div>
    );
  }

  return (
    <div
      {...handle.props}
      className={stateClasses('wf-card', entry, handle, running, awaiting)}
      data-type={entry.type}
    >
      <CardHead entry={entry} handle={handle} />
      <div className="wf-card__body">
        <CardBody entry={entry} />
      </div>
    </div>
  );
}
