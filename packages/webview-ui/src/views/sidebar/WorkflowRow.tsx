import { useEffect, useRef } from 'react';
import type { ActiveRunSummary, WorkflowSummary } from '@isar-flow/core';
import { Chip, IconButton, RunOriginChip, Spinner, StatusGlyph, statusLabel } from '../../components';
import { formatRelativeTime } from '../../hooks';
import { formatElapsed, plural, send, workflowLabel } from './model';
import { PathText } from './PathText';

/** Labels of the workflow's triggers ("On save: src/**", "Every hour"); a lenient host may send anything. */
function triggerLabels(triggers: unknown): string[] {
  if (!Array.isArray(triggers)) return [];
  return triggers
    .map((trigger: unknown) =>
      typeof trigger === 'object' && trigger !== null ? (trigger as { label?: unknown }).label : undefined,
    )
    .filter((label): label is string => typeof label === 'string' && label.trim() !== '');
}

export function WorkflowRow({
  workflow,
  run,
  trusted,
  now,
}: {
  workflow: WorkflowSummary;
  /** The workflow's run in progress, if any. */
  run: ActiveRunSummary | undefined;
  trusted: boolean;
  now: number;
}) {
  const label = workflowLabel(workflow);
  const triggers = triggerLabels(workflow.triggers);
  const running = run !== undefined;
  const uri = typeof workflow.uri === 'string' ? workflow.uri : '';
  const path = workflow.relativePath || '';
  const blockedReason = !trusted
    ? 'Running is disabled until you trust this workspace.'
    : workflow.valid === false
      ? 'Fix the problems in this workflow before running it.'
      : undefined;

  // Run and Stop replace each other; when the one that was pressed disappears, focus moves to the other.
  const actionRef = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) actionRef.current?.focus();
  }, [running]);

  return (
    <div className="sb-row">
      <button
        type="button"
        className="sb-row__main"
        onClick={() => uri && send({ type: 'openWorkflow', uri })}
        title={workflow.description || undefined}
      >
        <span className={run ? 'sb-tile sb-tile--running' : 'sb-tile'} aria-hidden="true">
          <i className="codicon codicon-pulse" />
        </span>
        <span className="sb-row__body">
          <span className="sb-row__title">
            <span className="sb-row__name" title={label}>
              {label}
            </span>
            {triggers.length ? (
              <i
                className="codicon codicon-zap sb-trigger"
                role="img"
                aria-label="Triggers"
                title={triggers.join('\n')}
              />
            ) : null}
          </span>
          {path ? <PathText path={path} /> : null}
          <span className="sb-row__meta">
            <RunLine workflow={workflow} run={run} now={now} />
          </span>
          {workflow.exposed === true ? (
            <span className="sb-row__chips">
              <Chip icon="copilot" title="Copilot can run this workflow">
                Copilot
              </Chip>
            </span>
          ) : null}
        </span>
      </button>
      <div className="sb-row__trail">
        {run ? (
          <>
            <span className="sb-running">
              <Spinner label="Running" />
            </span>
            <IconButton
              ref={actionRef}
              icon="debug-stop"
              label={`Stop ${label}`}
              className="sb-stop-btn"
              onClick={() => {
                pressed.current = true;
                send({ type: 'cancelRun', runId: run.runId });
              }}
            />
          </>
        ) : (
          <span title={blockedReason}>
            <IconButton
              ref={actionRef}
              icon="play"
              label={`Run ${label}`}
              className="sb-run-btn"
              disabled={blockedReason !== undefined}
              onClick={() => {
                if (!uri) return;
                pressed.current = true;
                send({ type: 'runWorkflow', uri });
              }}
            />
          </span>
        )}
      </div>
    </div>
  );
}

function RunLine({
  workflow,
  run,
  now,
}: {
  workflow: WorkflowSummary;
  run: ActiveRunSummary | undefined;
  now: number;
}) {
  if (run) {
    return (
      <>
        <span className="sb-meta-running">Running</span>
        <span className="sb-meta-elapsed">{formatElapsed(now - run.startedAt)}</span>
      </>
    );
  }
  if (workflow.valid === false) {
    return (
      <Chip tone="warning" icon="warning" title="Open the workflow to see and fix the problems.">
        Has problems
      </Chip>
    );
  }
  const last = workflow.lastRun;
  if (!last) {
    const steps = typeof workflow.stepCount === 'number' ? workflow.stepCount : 0;
    return (
      <>
        <i className="codicon codicon-circle-large-outline sb-meta-glyph" aria-hidden="true" />
        <span>Not run yet</span>
        <Chip>{steps > 0 ? plural(steps, 'block') : 'No blocks yet'}</Chip>
      </>
    );
  }
  return (
    <>
      <StatusGlyph status={last.status} />
      <span className="sb-meta-status">{statusLabel(last.status)}</span>
      <span>{formatRelativeTime(last.startedAt, now)}</span>
      <RunOriginChip run={last} />
    </>
  );
}
