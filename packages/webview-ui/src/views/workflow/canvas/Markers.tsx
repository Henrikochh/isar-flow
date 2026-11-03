/** Start and End markers at the source and mouth of the river. */
import {
  Chip,
  hasRunOriginChip,
  SimulatedChip,
  StartedByChip,
  StatusGlyph,
  statusLabel,
} from '../../../components';
import { formatDuration } from '../../../hooks';
import type { RunView, Workflow, WorkflowTriggerState } from '@isar-flow/core';
import { blockName } from '../runFromHere/model';
import { TriggerStatus } from './TriggerStatus';

function inputNames(workflow: Workflow | null): string[] {
  const inputs: unknown = workflow?.inputs;
  return typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs) ? Object.keys(inputs) : [];
}

/** Chip for how the shown run started: simulated, resumed from a block of an earlier run, a trigger, Copilot, … */
function RunOrigin({ run, workflow }: { run: RunView; workflow: Workflow | null }) {
  if (run.simulated)
    return <SimulatedChip title="Nothing was executed: results come from the simulation file." />;
  if (!run.resumedFrom) return <StartedByChip origin={run.origin} tone="isar" />;
  const label = `Resumed from ${blockName(workflow, run.resumedFrom.stepId)}`;
  return (
    <Chip tone="isar" icon="run-below" title={label}>
      {label}
    </Chip>
  );
}

export function StartMarker({
  workflow,
  run = null,
  triggers = null,
}: {
  workflow: Workflow | null;
  run?: RunView | null;
  /** The workflow's triggers and whether they start runs (null until the host sent them). */
  triggers?: WorkflowTriggerState | null;
}) {
  const names = inputNames(workflow);
  return (
    <div className="wf-marker wf-marker--start">
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
        {run && hasRunOriginChip(run) ? (
          <span className="wf-marker__origin">
            <RunOrigin run={run} workflow={workflow} />
          </span>
        ) : null}
        {names.length ? (
          <span className="wf-marker__inputs" aria-label="Inputs">
            {names.map((name) => (
              <Chip key={name} code tone="outline" title={`Input ${name}`}>
                {name}
              </Chip>
            ))}
          </span>
        ) : null}
        {triggers ? <TriggerStatus state={triggers} /> : null}
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
