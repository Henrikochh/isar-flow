import { ToolError } from './toolContext';

/** Optional string argument; throws ToolError when it has another type. */
export function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError(`"${name}" must be a string.`);
  return value;
}

/** Required string argument (may be empty). */
export function requiredString(args: Record<string, unknown>, name: string): string {
  const value = stringArg(args, name);
  if (value === undefined) throw new ToolError(`"${name}" is required.`);
  return value;
}

export function booleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ToolError(`"${name}" must be true or false.`);
  return value;
}

/** Optional 1-based line number. */
export function lineArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolError(`"${name}" must be a whole number of at least 1.`);
  }
  return value;
}
