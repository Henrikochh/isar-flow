import { resolveInputs, type Workflow } from '@isar-flow/core';

const NOT_AN_OBJECT = 'Pass inputs as an object with values by input name, e.g. { "version": "1.2.0" }.';
/** The yes/no words the command line accepts too; anything else is refused rather than read as true. */
const TRUE_WORDS = new Set(['true', 'yes', 'y', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', 'off', '0']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A boolean input's value, or undefined when it is missing; throws for values that aren't yes or no. */
function booleanValue(name: string, value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const word =
    typeof value === 'string' || typeof value === 'number' ? String(value).trim().toLowerCase() : '';
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  throw new Error(`Input '${name}' must be true or false, but got '${shown}'.`);
}

/**
 * Checks the inputs Copilot (or `/run name=value`) passes before a run starts, so mistakes come back as clear
 * errors: unknown names, wrong types, missing required inputs. Returns the given values converted to their input
 * types; defaults are left to the run, which may fill them from templates.
 */
export function checkInputs(workflow: Workflow, given: unknown): Record<string, unknown> {
  if (given !== undefined && given !== null && !isPlainObject(given)) throw new Error(NOT_AN_OBJECT);
  const values = isPlainObject(given) ? given : {};
  const declared = isPlainObject(workflow.inputs) ? workflow.inputs : {};
  const names = Object.keys(declared);
  for (const name of Object.keys(values)) {
    if (Object.hasOwn(declared, name)) continue;
    const known = names.length > 0 ? `Its inputs: ${names.join(', ')}.` : 'It has no inputs.';
    throw new Error(`${workflow.name} has no input '${name}'. ${known}`);
  }
  const typed = { ...values };
  for (const [name, def] of Object.entries(declared)) {
    if (def.type !== 'boolean' || !Object.hasOwn(values, name)) continue;
    const value = booleanValue(name, values[name]);
    if (value !== undefined) typed[name] = value;
  }
  const resolved = resolveInputs(declared, typed);
  return Object.fromEntries(
    Object.keys(values)
      .filter((name) => Object.hasOwn(resolved, name))
      .map((name) => [name, resolved[name]]),
  );
}
