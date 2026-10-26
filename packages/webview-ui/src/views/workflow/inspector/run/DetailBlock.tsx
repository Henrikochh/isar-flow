import { useId, useState } from 'react';
import { IconButton } from '../../../../components';
import { useWorkflowActions } from '../../store';

/** Collapsible code block for the rendered prompt / command of a run; shows its first line while closed. */
export function DetailBlock({ label, text, defaultOpen }: { label: string; text: string; defaultOpen: boolean }) {
  const actions = useWorkflowActions();
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '';
  return (
    <div className="wf-detail">
      <div className="wf-detail-head">
        <button
          type="button"
          className="wf-insp-disclosure-toggle wf-detail-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <i className={`codicon codicon-chevron-${open ? 'down' : 'right'} wf-insp-chevron`} aria-hidden="true" />
          <span className="wf-detail-label">{label}</span>
          {open ? null : <span className="wf-detail-preview">{firstLine}</span>}
        </button>
        <IconButton icon="copy" label={`Copy ${label.toLowerCase()}`} onClick={() => actions.copy(text)} />
      </div>
      {open ? (
        <pre className="wf-insp-code wf-detail-body" id={bodyId}>
          {text}
        </pre>
      ) : null}
    </div>
  );
}
