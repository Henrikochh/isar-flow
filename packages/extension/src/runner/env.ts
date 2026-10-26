/**
 * Variables the VS Code extension host sets for its own process. Inherited, ELECTRON_RUN_AS_NODE makes every
 * Electron program a command starts (VS Code in extension tests, Electron apps) run as plain Node instead.
 */
const HOST_ONLY_VARIABLES = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'];

/** The environment of a console command: like the integrated terminal, without the host-only variables. */
export function commandEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const hostOnly = (key: string) =>
    HOST_ONLY_VARIABLES.includes(platform === 'win32' ? key.toUpperCase() : key);
  const inherited = Object.fromEntries(Object.entries(base).filter(([key]) => !hostOnly(key)));
  return mergeEnv(inherited, extra, platform);
}

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
