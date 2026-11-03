/** Pure name and path helpers for simulation files. Paths are URI paths (forward slashes). */

/** Watches every simulation file of the workspace. */
export const SIMULATION_GLOB = '**/.isarflow/simulations/*.sim.{yaml,yml}';
export const SIMULATIONS_FOLDER = ['.isarflow', 'simulations'] as const;

const WORKFLOW_SUFFIX = /\.workflow\.ya?ml$/i;
const SIMULATION_PATH = /\/\.isarflow\/simulations\/[^/]+\.sim\.ya?ml$/i;

/**
 * Name of a workflow's simulation file without `.sim.yaml`: the file name without `.workflow.yaml` /
 * `.workflow.yml` (any case); other file names lose their last extension.
 */
export function simulationName(fileName: string): string {
  const match = WORKFLOW_SUFFIX.exec(fileName);
  if (match && match.index > 0) return fileName.slice(0, match.index);
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function isSimulationPath(path: string): boolean {
  return SIMULATION_PATH.test(path);
}
