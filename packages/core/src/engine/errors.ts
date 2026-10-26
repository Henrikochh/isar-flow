import type { Usage } from './types';

/**
 * An agent block failed after the model had already used tokens (turn limit reached, failed JSON repair,
 * cancellation, model error in a later turn). The engine still counts `usage` towards the run total and
 * the token budget. `cause` holds the original error.
 */
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentRunError';
  }
}

const tokens = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Usage carried by a failed host call, if any. */
export function usageOfError(error: unknown): Usage | undefined {
  if (!(error instanceof AgentRunError)) return undefined;
  // Hosts are not type-checked at runtime, so the usage may be missing or malformed.
  const usage: Partial<Usage> | undefined = error.usage;
  return { inputTokens: tokens(usage?.inputTokens), outputTokens: tokens(usage?.outputTokens) };
}
