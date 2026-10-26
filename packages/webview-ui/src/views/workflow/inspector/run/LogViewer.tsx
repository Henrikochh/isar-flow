import { useLayoutEffect, useRef } from 'react';
import type { LogLine } from '@isar-flow/core';
import { IconButton } from '../../../../components';
import { useWorkflowActions } from '../../store';

const FOLLOW_SLACK = 24;

/** Monospace console output; stderr lines are tinted, and the view follows new lines while running. */
export function LogViewer({
  lines,
  running,
  truncated,
  label = 'Output',
}: {
  lines: readonly LogLine[];
  running: boolean;
  truncated?: boolean;
  label?: string;
}) {
  const actions = useWorkflowActions();
  const bodyRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && running && follow.current) body.scrollTop = body.scrollHeight;
  }, [lines, running]);

  const text = lines.map((line) => line.text).join('');
  const errors = lines.filter((line) => line.stream === 'stderr').length;

  return (
    <div className="wf-log">
      <div className="wf-log-head">
        <span className="wf-log-title">{label}</span>
        <span className="wf-log-count">
          {lines.length === 1 ? '1 line' : `${lines.length} lines`}
          {errors ? <span className="wf-log-count-err">{errors === 1 ? '1 error line' : `${errors} error lines`}</span> : null}
        </span>
        <IconButton icon="copy" label="Copy output" disabled={text === ''} onClick={() => actions.copy(text)} />
      </div>
      <div
        ref={bodyRef}
        className="wf-log-body"
        role="log"
        aria-label={label}
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
        }}
      >
        {truncated ? <div className="wf-log-note">Earlier lines were dropped to keep the view fast.</div> : null}
        {lines.length === 0 ? (
          <div className="wf-log-note">{running ? 'Waiting for output…' : 'No output.'}</div>
        ) : (
          lines.map((line, index) => (
            <div key={index} className={line.stream === 'stderr' ? 'wf-log-line wf-log-line--err' : `wf-log-line wf-log-line--${line.stream}`}>
              {line.text.replace(/\r?\n$/, '') || ' '}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
