import { useMemo } from 'react';
import { liveValue } from '@isar-flow/core';
import { useWorkflowState } from '../store';
import { useLiveContext } from './LiveDataProvider';
import { LiveValueTip } from './LiveValueTip';
import type { HoverTarget } from './useHoverTip';

/** The hover card of one template on the canvas, evaluated in the shown or the last run. */
export function TemplateValueTip({
  target,
  stepId,
  onMouseEnter,
  onMouseLeave,
}: {
  target: HoverTarget;
  /** Block the template belongs to (decides what `loop.*` reads). */
  stepId?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const snapshot = useLiveContext();
  const { doc, lastWorkflow } = useWorkflowState();
  const workflow = doc?.workflow ?? lastWorkflow ?? null;
  const value = useMemo(
    () => (snapshot ? liveValue(snapshot.context, target.expression, { workflow, stepId }) : null),
    [snapshot, target.expression, workflow, stepId],
  );
  if (!snapshot || !value) return null;
  return (
    <LiveValueTip
      anchor={target.anchor}
      snapshot={snapshot}
      expression={target.expression}
      value={value}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    />
  );
}
