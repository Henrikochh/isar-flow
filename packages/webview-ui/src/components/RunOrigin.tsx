import { type RunOrigin, runOriginText } from '@isar-flow/core';
import { Chip } from './Display';

const SIMULATED_TITLE = 'Nothing was executed: results came from the simulation file.';

/** "Simulated" in the simulation tone with the beaker: the same chip wherever a simulated run is named. */
export function SimulatedChip({ title = SIMULATED_TITLE }: { title?: string }) {
  return (
    <Chip tone="simulated" icon="beaker" title={title}>
      Simulated
    </Chip>
  );
}

/**
 * "On save", "Copilot", "Selection", …: how a run started, with the full sentence as tooltip; nothing for manual.
 * Quiet (outline) in lists; the Start marker tones it, so it does not read as one of the workflow's triggers.
 */
export function StartedByChip({
  origin,
  tone = 'outline',
}: {
  origin: RunOrigin | undefined;
  tone?: 'outline' | 'isar';
}) {
  const text = runOriginText(origin);
  if (!text) return null;
  return (
    <Chip tone={tone} icon={text.icon} title={text.sentence}>
      {text.chip}
    </Chip>
  );
}

/**
 * "Simulated", "Resumed" or how the run started (trigger, Copilot, selection) for a run in a list (history, Runs
 * menu, sidebar); nothing for a normal run started by hand. A resumed run ran for real, so its chip stays quiet.
 */
export function RunOriginChip({
  run,
  blockName = (id) => id,
}: {
  run: { simulated?: boolean; resumedFrom?: { runId: string; stepId: string }; origin?: RunOrigin };
  /** Display name of a block id (the block's name, else its id). */
  blockName?: (id: string) => string;
}) {
  if (run.simulated) return <SimulatedChip />;
  const stepId = run.resumedFrom?.stepId;
  if (typeof stepId !== 'string') return <StartedByChip origin={run.origin} />;
  return (
    <Chip tone="outline" icon="run-below" title={`Resumed from ${blockName(stepId)}`}>
      Resumed
    </Chip>
  );
}

/** True when RunOriginChip shows something for the run. */
export function hasRunOriginChip(run: {
  simulated?: boolean;
  resumedFrom?: { stepId?: unknown };
  origin?: RunOrigin;
}): boolean {
  return run.simulated === true || typeof run.resumedFrom?.stepId === 'string' || !!runOriginText(run.origin);
}
