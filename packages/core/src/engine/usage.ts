import type { Usage } from './types';

/** The `usage` of block outputs when it holds two numbers (agent blocks); undefined otherwise. */
export function usageOfOutput(output: Record<string, unknown>): Usage | undefined {
  const usage = output.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const { inputTokens, outputTokens } = usage as Record<string, unknown>;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;
  return { inputTokens, outputTokens };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}
