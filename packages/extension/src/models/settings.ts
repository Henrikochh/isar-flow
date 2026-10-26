import type { ProviderConfig } from '../contracts';

/** Provider ids: the first part of model references (`<id>/<model>`). */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** The provider id of the language models VS Code offers. */
export const VSCODE_PROVIDER_ID = 'vscode';

const SECRET_PREFIX = 'isarFlow.provider.';
const SECRET_SUFFIX = '.apiKey';
const SETTING = 'isarFlow.providers';

/** SecretStorage key of a provider's API key. */
export function apiKeySecret(providerId: string): string {
  return `${SECRET_PREFIX}${providerId}${SECRET_SUFFIX}`;
}

/** The provider id a SecretStorage key belongs to, or undefined when it is not a provider API key. */
export function providerIdFromSecret(key: string): string | undefined {
  if (!key.startsWith(SECRET_PREFIX) || !key.endsWith(SECRET_SUFFIX)) return undefined;
  const id = key.slice(SECRET_PREFIX.length, -SECRET_SUFFIX.length);
  return id || undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Input-box validation of a new provider id; returns the problem or undefined. */
export function checkProviderId(value: string, takenIds: Iterable<string>): string | undefined {
  const id = value.trim();
  if (!id) return 'Enter a short id, for example litellm.';
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return 'Use lowercase letters, digits, - and _, starting with a letter or digit.';
  }
  if (id === VSCODE_PROVIDER_ID)
    return "The id 'vscode' is reserved for VS Code's own models. Choose another id.";
  if ([...takenIds].includes(id)) return `An endpoint with the id '${id}' already exists. Choose another id.`;
  return undefined;
}

/** Input-box validation of a base URL; returns the problem or undefined. */
export function checkBaseUrl(value: string): string | undefined {
  if (!value.trim()) return 'Enter the base URL, for example http://localhost:4000/v1.';
  if (!isHttpUrl(value))
    return 'Enter a full http:// or https:// address, for example http://localhost:4000/v1.';
  return undefined;
}

/** `base`, or `base-2`, `base-3` … when taken. */
export function suggestProviderId(base: string, takenIds: Iterable<string>): string {
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Validates the raw `isarFlow.providers` setting. Entries without a usable id or base URL are skipped;
 * malformed optional fields are dropped. Every problem is described in a sentence for the user.
 */
export function readProviderConfigs(raw: unknown): { configs: ProviderConfig[]; problems: string[] } {
  const configs: ProviderConfig[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { configs, problems };
  if (!Array.isArray(raw)) {
    problems.push(`The setting ${SETTING} must be a list of endpoints. Fix it in settings.json.`);
    return { configs, problems };
  }

  const seen = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const position = `Entry ${index + 1} of ${SETTING}`;
    if (!isRecord(entry)) {
      problems.push(`${position} is not an object with id and baseUrl; it is ignored.`);
      return;
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!PROVIDER_ID_PATTERN.test(id)) {
      const shown = typeof entry.id === 'string' ? ` '${entry.id}'` : '';
      problems.push(
        `${position} has an invalid id${shown}. Use lowercase letters, digits, - and _, starting with a letter or digit.`,
      );
      return;
    }
    if (id === VSCODE_PROVIDER_ID) {
      problems.push(
        `The endpoint id 'vscode' is reserved for VS Code's own models. Choose another id in ${SETTING}.`,
      );
      return;
    }
    if (seen.has(id)) {
      problems.push(
        `The endpoint id '${id}' is used more than once in ${SETTING}; only the first one is used.`,
      );
      return;
    }
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
    if (!isHttpUrl(baseUrl)) {
      const problem = baseUrl ? `has an invalid base URL '${baseUrl}'` : 'has no base URL';
      problems.push(
        `The endpoint '${id}' ${problem}. Use a full http:// or https:// address, for example http://localhost:4000/v1.`,
      );
      return;
    }
    seen.add(id);
    configs.push(readOptionalFields(id, baseUrl, entry, problems));
  });
  return { configs, problems };
}

function readOptionalFields(
  id: string,
  baseUrl: string,
  entry: Record<string, unknown>,
  problems: string[],
): ProviderConfig {
  const config: ProviderConfig = { id, label: id, baseUrl };
  const where = `The endpoint '${id}'`;

  if (typeof entry.label === 'string' && entry.label.trim()) config.label = entry.label.trim();
  else if (entry.label !== undefined && typeof entry.label !== 'string') {
    problems.push(`${where} has a label that is not text; the id is shown instead.`);
  }

  if (typeof entry.discoverModels === 'boolean') config.discoverModels = entry.discoverModels;
  else if (entry.discoverModels !== undefined) {
    problems.push(`${where} has a discoverModels value that is not true or false; models are discovered.`);
  }

  if (Array.isArray(entry.models)) {
    const models = entry.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '');
    if (models.length < entry.models.length)
      problems.push(`${where} lists models that are not text; they are ignored.`);
    if (models.length) config.models = models.map((m) => m.trim());
  } else if (entry.models !== undefined) {
    problems.push(`${where} has a models value that is not a list of model ids; it is ignored.`);
  }

  if (isRecord(entry.headers)) {
    const headers = Object.entries(entry.headers).filter(
      (h): h is [string, string] => typeof h[1] === 'string',
    );
    if (headers.length < Object.keys(entry.headers).length) {
      problems.push(`${where} has headers whose values are not text; they are not sent.`);
    }
    if (headers.length) config.headers = Object.fromEntries(headers);
  } else if (entry.headers !== undefined) {
    problems.push(`${where} has a headers value that is not an object of names and values; it is ignored.`);
  }
  return config;
}
