/**
 * The environment for a spawned command: `base` (usually process.env) with `extra` on top. Windows treats
 * variable names case-insensitively, so an extra `PATH` replaces an inherited `Path` instead of
 * producing two conflicting entries.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (platform === 'win32') {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(result)) {
        if (existing !== key && existing.toLowerCase() === lower) delete result[existing];
      }
    }
    result[key] = value;
  }
  return result;
}

/** Reads an environment variable, ignoring the case of its name on Windows. */
export function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name];
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : env[key];
}
