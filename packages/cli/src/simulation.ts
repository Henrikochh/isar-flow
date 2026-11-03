import path from 'node:path';
import { parseSimulationText, type SimulationFile, validateSimulation, type Workflow } from '@isar-flow/core';
import { displayPath, errorSummary, formatDiagnostic } from './diagnostics';
import { CliError } from './errors';
import { readFirstTextFile } from './files';

/**
 * The mocks of a simulated run: `<root>/.isarflow/simulations/<name>.sim.yaml` (or `.yml`), where name is the
 * workflow file name without `.workflow.yaml`. Without the file every block gets its default result. Throws a
 * CliError when the file has errors; mocks that don't fit the workflow are warnings.
 */
export async function loadSimulation(
  root: string,
  workflowFile: string,
  workflow: Workflow,
  cwd: string,
): Promise<{ file: SimulationFile; path?: string; warnings: string[] }> {
  const name = path.basename(workflowFile).replace(/\.workflow\.ya?ml$/i, '');
  const folder = path.join(root, '.isarflow', 'simulations');
  const found = await readFirstTextFile([
    path.join(folder, `${name}.sim.yaml`),
    path.join(folder, `${name}.sim.yml`),
  ]);
  if (!found) return { file: {}, warnings: [] };
  const display = displayPath(found.file, cwd);
  const parsed = parseSimulationText(found.text);
  const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (!parsed.file || errors.length > 0) {
    throw new CliError(
      errorSummary('The simulation file', Math.max(errors.length, 1)),
      errors.map((d) => formatDiagnostic(display, d)),
    );
  }
  const warnings = [
    ...parsed.diagnostics.filter((d) => d.severity === 'warning'),
    ...validateSimulation(parsed.file, workflow, parsed.blockRanges),
  ].map((d) => formatDiagnostic(display, d));
  return { file: parsed.file, path: found.file, warnings };
}
