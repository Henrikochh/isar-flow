import { z } from 'zod';
import type { ProjectConfig } from './types';

/** Provider ids as in the VS Code settings: lowercase letters, digits, - and _. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isHttpUrl = (text: string): boolean => {
  try {
    const { protocol } = new URL(text.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const ProviderSchema = z.strictObject({
  id: z
    .string()
    .regex(PROVIDER_ID_PATTERN, 'Use lowercase letters, digits, - and _ for provider ids, e.g. "litellm"')
    .refine((id) => id !== 'vscode', {
      message: "The id 'vscode' is reserved for VS Code's own models, which the command line can't use",
    })
    .meta({ description: 'First part of model references, e.g. "litellm" in "litellm/gpt-4.1".' }),
  label: z.string().optional(),
  baseUrl: z
    .string()
    .refine(isHttpUrl, 'Enter a full http:// or https:// address, e.g. "http://localhost:4000/v1"')
    .meta({ description: 'API root of the OpenAI-compatible endpoint, e.g. "http://localhost:4000/v1".' }),
  apiKeyEnv: z
    .string()
    .regex(ENV_NAME_PATTERN, 'Use the name of an environment variable, e.g. "LITELLM_API_KEY"')
    .optional()
    .meta({
      description:
        'Environment variable that holds the API key (default ISARFLOW_<ID>_API_KEY). Never put the key itself here.',
    }),
  discoverModels: z
    .boolean()
    .optional()
    .meta({ description: 'Ask the endpoint for its models (default true).' }),
  models: z.array(z.string().min(1)).optional().meta({ description: 'Model ids to offer.' }),
  headers: z.record(z.string(), z.string()).optional().meta({ description: 'Extra HTTP headers.' }),
});

/** `.isarflow/config.yaml`: settings of the command line runner (`isar-flow run`). */
export const ProjectConfigSchema: z.ZodType<ProjectConfig> = z.strictObject({
  version: z.literal(1).optional().meta({ description: 'Isar Flow config format version.' }),
  providers: z
    .array(ProviderSchema)
    .optional()
    .meta({ description: 'OpenAI-compatible endpoints for `isar-flow run` (VS Code uses its settings).' }),
});
