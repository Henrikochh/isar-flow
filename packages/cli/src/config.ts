import path from 'node:path';
import { parseProjectConfigText, type ProjectConfig } from '@isar-flow/core';
import { displayPath, errorSummary, formatDiagnostic } from './diagnostics';
import { CliError } from './errors';
import { readFirstTextFile } from './files';

/** `<root>/.isarflow/config.yaml` (or `.yml`); an empty config without the file. Throws a CliError for errors. */
export async function loadProjectConfig(
  root: string,
  cwd: string,
): Promise<{ config: ProjectConfig; file?: string }> {
  const folder = path.join(root, '.isarflow');
  const found = await readFirstTextFile([path.join(folder, 'config.yaml'), path.join(folder, 'config.yml')]);
  if (!found) return { config: {} };
  const parsed = parseProjectConfigText(found.text);
  const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (!parsed.config || errors.length > 0) {
    const display = displayPath(found.file, cwd);
    throw new CliError(
      errorSummary('The config file', Math.max(errors.length, 1)),
      errors.map((d) => formatDiagnostic(display, d)),
    );
  }
  return { config: parsed.config, file: found.file };
}
