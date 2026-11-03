/** A live value as the tooltip and the inspector show it: the text in the code font, its type and notes. */
import type { LiveValue, LiveValueType } from '@isar-flow/core';
import { StatusGlyph } from '../../../components';
import { formatRelativeTime } from '../../../hooks';
import type { LiveSnapshot } from './LiveDataProvider';
import { liveRunName } from './runName';
import './live.css';

export const TYPE_LABELS: Record<LiveValueType, string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Yes / no',
  list: 'List',
  object: 'Object',
  empty: 'Empty',
};

export const TRUNCATED_NOTE = 'Showing the first 2 KB.';
export const MASKED_NOTE = 'Contains a secret, shown as ••••••.';

/** "This run" or "Last run" (a simulation in its tone, with the beaker) with its status and start time. */
export function LiveRunLabel({ snapshot, now }: { snapshot: LiveSnapshot; now?: number }) {
  const { context, source } = snapshot;
  const simulated = context.simulated === true;
  return (
    <div className="wf-live-run">
      <StatusGlyph status={context.status} />
      <span className={simulated ? 'wf-live-run__name wf-live-run__name--simulated' : 'wf-live-run__name'}>
        {simulated ? <i className="codicon codicon-beaker" aria-hidden="true" /> : null}
        {liveRunName(source, simulated)}
      </span>
      <span className="wf-live-run__time">{formatRelativeTime(context.startedAt, now)}</span>
    </div>
  );
}

/** Type label of a value; nothing for unavailable values and errors. */
export function liveTypeLabel(value: LiveValue): string | undefined {
  return value.kind === 'value' ? TYPE_LABELS[value.type] : undefined;
}

/** The value text (plain text, never HTML) and its notes, or the reason there is none. */
export function LiveValueView({ value }: { value: LiveValue }) {
  if (value.kind !== 'value') {
    return (
      <p className="wf-live-msg">
        <i
          className={`codicon codicon-${value.kind === 'error' ? 'warning' : 'info'} wf-live-msg__icon`}
          aria-hidden="true"
        />
        {value.message}
      </p>
    );
  }
  return (
    <>
      {value.text !== '' ? <pre className="wf-live-value">{value.text}</pre> : null}
      {value.truncated ? <p className="wf-live-note">{TRUNCATED_NOTE}</p> : null}
      {value.masked ? <p className="wf-live-note">{MASKED_NOTE}</p> : null}
    </>
  );
}
