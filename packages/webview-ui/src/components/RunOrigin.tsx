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
 * "Simulated" or "Resumed" chip for a run in a list (history, Runs menu, sidebar); nothing for a normal run.
 * A resumed run ran for real, so its chip stays quiet.
 */
export function RunOriginChip({
  run,
  blockName = (id) => id,
}: {
  run: { simulated?: boolean; resumedFrom?: { runId: string; stepId: string } };
  /** Display name of a block id (the block's name, else its id). */
  blockName?: (id: string) => string;
}) {
  if (run.simulated) return <SimulatedChip />;
  const stepId = run.resumedFrom?.stepId;
  if (typeof stepId !== 'string') return null;
  return (
    <Chip tone="outline" icon="run-below" title={`Resumed from ${blockName(stepId)}`}>
      Resumed
    </Chip>
  );
}
