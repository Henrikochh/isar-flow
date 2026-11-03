/** What an if or loop condition evaluated to in the last run, for the canvas headers and the condition builder. */
import { useMemo } from 'react';
import { lastConditionResult } from '@isar-flow/core';
import { Chip } from '../../../components';
import { findBlock } from '../inspector/model';
import { useWorkflowState } from '../store';
import { useLiveContext, useLiveData } from './LiveDataProvider';
import { liveRunName } from './runName';
import './live.css';

/** The last run's result, only while no run is shown (a shown run tells it with lanes and iterations). */
export function useLastRunCondition(step: unknown): boolean | undefined {
  const { run } = useWorkflowState();
  const { lastRunContext } = useLiveData();
  return useMemo(
    () => (run || !lastRunContext ? undefined : lastConditionResult(step, lastRunContext)),
    [run, lastRunContext, step],
  );
}

/** `Last run: true` on an if header or a loop summary (`Last simulation: …` in its tone); nothing when unknown. */
export function LastRunConditionChip({ step, className }: { step: unknown; className?: string }) {
  const result = useLastRunCondition(step);
  const { lastRunContext } = useLiveData();
  if (result === undefined) return null;
  const simulated = lastRunContext?.simulated === true;
  const name = liveRunName('last', simulated);
  const chip = (
    <Chip
      tone={simulated ? 'simulated' : 'outline'}
      icon={result ? 'pass' : 'circle-slash'}
      title={`The condition was ${result} when the ${name.toLowerCase()} checked it.`}
    >
      {`${name}: ${result}`}
    </Chip>
  );
  return className ? <div className={className}>{chip}</div> : chip;
}

/** "This run: false" or "Last run: true" (or "… simulation: …") for the block's condition, when known. */
export function useConditionResultText(stepId: string): string | undefined {
  const snapshot = useLiveContext();
  const { doc } = useWorkflowState();
  const step = findBlock(doc?.workflow, stepId)?.step;
  if (!snapshot || !step) return undefined;
  const result = lastConditionResult(step, snapshot.context);
  if (result === undefined) return undefined;
  return `${liveRunName(snapshot.source, snapshot.context.simulated)}: ${result}`;
}
