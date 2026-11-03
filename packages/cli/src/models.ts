import {
  type ChatModel,
  ModelError,
  type ModelResolver,
  OpenAICompatClient,
  parseModelRef,
  type ProjectConfig,
} from '@isar-flow/core';
import { envValue } from '@isar-flow/core/node';
import type { Env } from './secrets';

const VSCODE_PROVIDER = 'vscode';
const VSCODE_MODELS =
  "VS Code models (vscode/…) aren't available on the command line. Add an OpenAI-compatible provider to " +
  '.isarflow/config.yaml and use its models.';

/** `my-llm` + `BASE_URL` → `ISARFLOW_MY_LLM_BASE_URL`. */
export function providerEnvName(id: string, suffix: 'BASE_URL' | 'API_KEY'): string {
  return `ISARFLOW_${id.toUpperCase().replace(/-/g, '_')}_${suffix}`;
}

export interface CliModelOptions {
  config: ProjectConfig;
  env: Env;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
}

/**
 * Resolves `<provider>/<model>` for the command line: providers of `.isarflow/config.yaml`, else the environment
 * variables `ISARFLOW_<ID>_BASE_URL` (and `ISARFLOW_<ID>_API_KEY`). The model is used as named, without asking
 * the server for its model list. Failures are ModelErrors of kind not-found, so fallback models still apply.
 */
export function createCliModelResolver(options: CliModelOptions): ModelResolver {
  const clients = new Map<string, OpenAICompatClient>();
  const read = (name: string) => envValue(options.env, name, options.platform) || undefined;

  const clientFor = (id: string): OpenAICompatClient => {
    const existing = clients.get(id);
    if (existing) return existing;
    const configured = options.config.providers?.find((provider) => provider.id === id);
    const baseUrl = configured?.baseUrl ?? read(providerEnvName(id, 'BASE_URL'));
    if (!baseUrl) {
      throw new ModelError(
        `Provider '${id}' isn't configured. Add it to .isarflow/config.yaml or set ${providerEnvName(id, 'BASE_URL')}.`,
        'not-found',
      );
    }
    const apiKey = read(configured?.apiKeyEnv ?? providerEnvName(id, 'API_KEY'));
    const client = new OpenAICompatClient({
      id,
      label: configured?.label ?? id,
      baseUrl,
      ...(apiKey && { apiKey }),
      ...(configured?.headers && { headers: configured.headers }),
      ...(configured?.models && { models: configured.models }),
      ...(configured?.discoverModels !== undefined && { discoverModels: configured.discoverModels }),
      ...(options.fetch && { fetch: options.fetch }),
    });
    clients.set(id, client);
    return client;
  };

  return {
    resolve: async (ref): Promise<ChatModel> => {
      const { provider, model } = parseModelRef(ref);
      if (provider === VSCODE_PROVIDER) throw new ModelError(VSCODE_MODELS, 'not-found');
      return clientFor(provider).model(model);
    },
  };
}
