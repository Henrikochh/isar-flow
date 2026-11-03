/**
 * Under a template field: the values its `${{ … }}` templates had in the shown or the last run, one row per
 * distinct expression, collapsed until opened.
 */
import { useId, useMemo, useState } from 'react';
import {
  findTemplateExpressions,
  type LiveValue,
  liveValue,
  type WorkflowEditorToHost,
} from '@isar-flow/core';
import { IconButton } from '../../../components';
import { post } from '../../../vscode';
import { useWorkflowState } from '../store';
import { type LiveSnapshot, useLiveContext } from './LiveDataProvider';
import { LiveValueView, liveTypeLabel } from './LiveValueView';
import { liveRunName } from './runName';

/** Distinct expressions of the templates in `text`, in order; none while a template is unterminated. */
export function templateExpressions(text: string): string[] {
  try {
    return [...new Set(findTemplateExpressions(text).map((match) => match.expr))];
  } catch {
    return [];
  }
}

function preview(value: LiveValue): { text: string; muted: boolean } {
  if (value.kind !== 'value') return { text: value.message, muted: true };
  if (value.text === '') return { text: 'Empty', muted: true };
  return { text: value.text.split('\n', 1)[0] ?? '', muted: false };
}

const copy = (text: string) => post<WorkflowEditorToHost>({ type: 'copyToClipboard', text });

function ValueRow({ expression, value }: { expression: string; value: LiveValue }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const line = preview(value);
  const type = liveTypeLabel(value);
  return (
    <li className="wf-liverow">
      <div className="wf-liverow__line">
        <button
          type="button"
          className="wf-liverow__main"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((current) => !current)}
        >
          <code className="wf-liverow__expr" title={expression}>
            {expression}
          </code>
          <span
            className={line.muted ? 'wf-liverow__preview wf-liverow__preview--muted' : 'wf-liverow__preview'}
          >
            {line.text}
          </span>
        </button>
        {value.kind === 'value' ? (
          <IconButton icon="copy" label={`Copy value of ${expression}`} onClick={() => copy(value.text)} />
        ) : null}
      </div>
      {open ? (
        <div id={detailId} className="wf-liverow__detail">
          {type ? <span className="wf-liverow__type">{type}</span> : null}
          <LiveValueView value={value} />
        </div>
      ) : null}
    </li>
  );
}

function ValueList({
  snapshot,
  text,
  stepId,
}: {
  snapshot: LiveSnapshot;
  text: string;
  stepId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { doc, lastWorkflow } = useWorkflowState();
  const workflow = doc?.workflow ?? lastWorkflow ?? null;
  const rows = useMemo(
    () =>
      templateExpressions(text).map((expression) => ({
        expression,
        value: liveValue(snapshot.context, expression, { workflow, stepId }),
      })),
    [text, snapshot, workflow, stepId],
  );
  if (rows.length === 0) return null;
  const name = liveRunName(snapshot.source, snapshot.context.simulated).toLowerCase();
  const title = `Values from ${snapshot.source === 'shown' ? name : `the ${name}`}`;
  return (
    <div className="wf-livevals">
      <button
        type="button"
        className="wf-livevals__toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <i className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
        {`${title} (${rows.length})`}
      </button>
      {open ? (
        <ul id={listId} className="wf-livevals__list" aria-label={title}>
          {rows.map((row) => (
            <ValueRow key={row.expression} expression={row.expression} value={row.value} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Nothing without a run to read from or without templates in the text. */
export function LiveValues({ text, stepId }: { text: string; stepId: string | null }) {
  const snapshot = useLiveContext();
  if (!snapshot || !text.includes('${{')) return null;
  return <ValueList snapshot={snapshot} text={text} stepId={stepId} />;
}
