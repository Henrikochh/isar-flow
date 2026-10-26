/** Start and End markers at the source and mouth of the river. */
import { Chip, StatusGlyph, statusLabel } from '../../../components';
import { formatDuration } from '../../../hooks';
import type { RunView, Workflow } from '@isar-flow/core';

function inputNames(workflow: Workflow | null): string[] {
  const inputs: unknown = workflow?.inputs;
  return typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs) ? Object.keys(inputs) : [];
}

export function StartMarker({ workflow }: { workflow: Workflow | null }) {
  const names = inputNames(workflow);
  return (
    <div className="wf-marker">
      <span />
      <span className="wf-marker__axis">
        <span className="wf-marker__dot wf-marker__dot--start">
          <i className="codicon codicon-play wf-marker__icon" aria-hidden="true" />
        </span>
        {/* Carries the river past input chips that wrap onto more rows. */}
        <span className="wf-marker__tail" aria-hidden="true" />
      </span>
      <span className="wf-marker__info">
        <span className="wf-marker__label">Start</span>
        {names.length ? (
          <span className="wf-marker__inputs" aria-label="Inputs">
            {names.map((name) => (
              <Chip key={name} code tone="outline" title={`Input ${name}`}>
                {name}
              </Chip>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function EndMarker({ run }: { run: RunView | null }) {
  const done = run && run.status !== 'running' ? run : null;
  const tone = done ? `wf-marker__dot--${done.status}` : '';
  return (
    <div className="wf-marker">
      <span />
      <span
        className={['wf-marker__dot wf-marker__dot--end', tone].filter(Boolean).join(' ')}
        aria-hidden="true"
      />
      <span className="wf-marker__info">
        <span className="wf-marker__label">End</span>
        {done ? (
          <span className="wf-marker__outcome">
            <StatusGlyph status={done.status} />
            <span>{statusLabel(done.status)}</span>
            {done.durationMs !== undefined ? (
              <span className="wf-marker__muted">{formatDuration(done.durationMs)}</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </div>
  );
}
