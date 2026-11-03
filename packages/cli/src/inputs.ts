import { resolveInputs, type Workflow } from '@isar-flow/core';
import { CliError, errorMessage } from './errors';
import { listText } from './format';

const TRUE = new Set(['true', 'yes', 'y', 'on', '1']);
const FALSE = new Set(['false', 'no', 'n', 'off', '0']);

/**
 * The run's inputs from `--input name=value` texts: required inputs must be given (an empty value counts as
 * missing), numbers and yes/no values are converted, defaults apply. Undeclared inputs are passed on with a warning.
 */
export function resolveCliInputs(
  workflow: Workflow,
  given: Record<string, string>,
): { inputs: Record<string, unknown>; warnings: string[] } {
  const declared = workflow.inputs ?? {};
  const values: Record<string, unknown> = { ...given };
  for (const [name, def] of Object.entries(declared)) {
    const value = Object.hasOwn(given, name) ? given[name] : undefined;
    const missing = value === undefined || value === '';
    if (missing && def.default === undefined && def.required) {
      throw new CliError(`Input '${name}' is required. Pass --input ${name}=value.`);
    }
    if (missing || def.type !== 'boolean') continue;
    const word = value.trim().toLowerCase();
    if (!TRUE.has(word) && !FALSE.has(word)) {
      throw new CliError(`Input '${name}' must be true or false, but got '${value}'.`);
    }
    values[name] = TRUE.has(word);
  }

  let inputs: Record<string, unknown>;
  try {
    inputs = resolveInputs(workflow.inputs, values);
  } catch (error) {
    throw new CliError(errorMessage(error));
  }
  const names = Object.keys(declared);
  const known = names.length === 0 ? 'It declares no inputs.' : `Its inputs are ${listText(names)}.`;
  const warnings = Object.keys(given)
    .filter((name) => !Object.hasOwn(declared, name))
    .map((name) => `The workflow has no input '${name}'; it is passed on anyway. ${known}`);
  return { inputs, warnings };
}
