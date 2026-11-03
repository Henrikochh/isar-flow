import type { Diagnostic } from '../diagnostics';
import { ProjectConfigSchema } from '../schema/config';
import { schemaDiagnostics } from './issues';
import { loadYaml } from './parse';
import type { ProjectConfigParseResult } from './types';

const KEY_HINT =
  "Don't put API keys in this file: store the key in an environment variable and name that variable in apiKeyEnv.";
/** Provider keys that look like an attempt to store the key itself. */
const KEY_LIKE = /^(api[-_]?key|key|token|secret|password)$/i;

function explainKey(diagnostic: Diagnostic): Diagnostic {
  const path = diagnostic.path ?? [];
  const key = path[path.length - 1];
  const inProvider = path.length === 3 && path[0] === 'providers';
  if (
    diagnostic.code !== 'unknown-property' ||
    !inProvider ||
    typeof key !== 'string' ||
    !KEY_LIKE.test(key)
  ) {
    return diagnostic;
  }
  return { ...diagnostic, message: `${diagnostic.message}. ${KEY_HINT}` };
}

/** Reads `.isarflow/config.yaml` (command line runner settings); an empty file is a valid, empty config. */
export function parseProjectConfigText(text: string): ProjectConfigParseResult {
  const loaded = loadYaml(text, 'config');
  if (!loaded.data) return { config: null, valid: false, diagnostics: loaded.diagnostics };
  const parsed = ProjectConfigSchema.safeParse(loaded.data);
  if (parsed.success) return { config: parsed.data, valid: true, diagnostics: loaded.diagnostics };
  const issues = schemaDiagnostics(parsed.error.issues, {
    ...loaded,
    data: loaded.data,
    text,
    blocks: false,
  });
  return { config: null, valid: false, diagnostics: [...loaded.diagnostics, ...issues.map(explainKey)] };
}
