import type { Usage } from './types';

export interface AgentRunErrorOptions extends ErrorOptions {
  /** Tool calls the agent made before it failed. */
  toolCalls?: number;
}

/**
 * An agent block failed after the model had already used tokens (turn limit reached, failed JSON repair,
 * cancellation, model error in a later turn). The engine still counts `usage` towards the run total and
 * the token budget, and shows `toolCalls` on the block. `cause` holds the original error.
 */
export class AgentRunError extends Error {
  readonly toolCalls?: number;

  constructor(
    message: string,
    readonly usage: Usage,
    options?: AgentRunErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentRunError';
    if (options?.toolCalls !== undefined) this.toolCalls = options.toolCalls;
  }
}

const tokens = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Tool calls carried by a failed host call, if any. */
export function toolCallsOfError(error: unknown): number | undefined {
  if (!(error instanceof AgentRunError)) return undefined;
  const count = tokens(error.toolCalls);
  return count > 0 ? count : undefined;
}

/** Usage carried by a failed host call, if any. */
export function usageOfError(error: unknown): Usage | undefined {
  if (!(error instanceof AgentRunError)) return undefined;
  // Hosts are not type-checked at runtime, so the usage may be missing or malformed.
  const usage: Partial<Usage> | undefined = error.usage;
  return { inputTokens: tokens(usage?.inputTokens), outputTokens: tokens(usage?.outputTokens) };
}
