/** The workflow's triggers on the Start marker: a chip each, then when it runs next or why it is paused. */
import type { TriggerPauseReason, WorkflowTriggerState } from '@isar-flow/core';
import { Button, Chip } from '../../../components';
import { useNow } from '../inspector/useNow';
import { useWorkflowActions, type WorkflowActions } from '../store';
import { TRIGGER_ICONS, triggerStatusLine, triggerTitle } from './triggerText';

const SETTING = 'isarFlow.triggers.enabled';

/** The one thing to do about a pause, where the canvas can do it. */
function PauseAction({
  reason,
  actions,
}: {
  reason: TriggerPauseReason | undefined;
  actions: WorkflowActions;
}) {
  switch (reason) {
    case 'approval':
      return (
        <Button size="s" variant="secondary" icon="play" onClick={() => actions.requestStart('run')}>
          Run once
        </Button>
      );
    case 'limited':
      return (
        <Button size="s" variant="secondary" icon="debug-continue" onClick={actions.resumeTriggers}>
          Resume
        </Button>
      );
    case 'disabled':
      return (
        <Button
          size="s"
          variant="secondary"
          icon="settings-gear"
          onClick={() => actions.openSettings(SETTING)}
        >
          Open settings
        </Button>
      );
    default:
      return null;
  }
}

export function TriggerStatus({ state }: { state: WorkflowTriggerState }) {
  const actions = useWorkflowActions();
  const triggers = Array.isArray(state.triggers) ? state.triggers : [];
  const now = useNow(triggers.length > 0, 30_000);
  if (!triggers.length) return null;
  const paused = state.status === 'paused';
  const line = triggerStatusLine(state, now);
  return (
    <span className="wf-marker__triggers" role="group" aria-label="Triggers">
      <span className="wf-marker__chips">
        {triggers.map((trigger, index) => (
          <Chip
            key={`${trigger.kind}:${index}`}
            tone="outline"
            icon={TRIGGER_ICONS[trigger.kind] ?? 'zap'}
            title={triggerTitle(trigger)}
          >
            <span className="wf-marker__chip-text">{trigger.label}</span>
          </Chip>
        ))}
      </span>
      {paused ? (
        <span className="wf-marker__paused">
          <Chip tone="warning" icon="debug-pause">
            Triggers paused
          </Chip>
          {state.pausedMessage ? <span className="wf-marker__status">{state.pausedMessage}</span> : null}
          <PauseAction reason={state.pausedReason} actions={actions} />
        </span>
      ) : line ? (
        <span className="wf-marker__status">{line}</span>
      ) : null}
    </span>
  );
}
