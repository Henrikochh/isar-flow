import { envValue } from '@isar-flow/core/node';

export const SECRET_ENV_PREFIX = 'ISARFLOW_SECRET_';

export type Env = Record<string, string | undefined>;

/** `api-token` → `ISARFLOW_SECRET_API_TOKEN`. */
export function secretEnvName(name: string): string {
  return `${SECRET_ENV_PREFIX}${name.toUpperCase().replace(/-/g, '_')}`;
}

const DOT_ACCESS = /\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)/g;
const BRACKET_ACCESS = /\bsecrets\s*\[\s*(['"])(.+?)\1\s*\]/g;

/** Names of `secrets.<name>` and `secrets['<name>']` in a workflow's text, sorted, without duplicates. */
export function referencedSecretNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(DOT_ACCESS)) names.add(match[1]);
  for (const match of text.matchAll(BRACKET_ACCESS)) names.add(match[2]);
  return [...names].sort();
}

/**
 * Secrets of a command line run: every `ISARFLOW_SECRET_<NAME>` variable as `<NAME>`, plus each referenced name
 * whose variable is set (so `secrets.api_token` reads `ISARFLOW_SECRET_API_TOKEN`). Empty values don't count.
 */
export function readSecrets(
  env: Env,
  referenced: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  const win = platform === 'win32';
  for (const [key, value] of Object.entries(env)) {
    const prefixed = win
      ? key.toUpperCase().startsWith(SECRET_ENV_PREFIX)
      : key.startsWith(SECRET_ENV_PREFIX);
    const name = key.slice(SECRET_ENV_PREFIX.length);
    if (prefixed && name !== '' && value) secrets[win ? name.toUpperCase() : name] = value;
  }
  for (const name of referenced) {
    const value = envValue(env, secretEnvName(name), platform);
    if (value) secrets[name] = value;
  }
  return secrets;
}

/** The process environment for `env.*` and console commands (unset entries dropped). */
export function processEnv(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}
