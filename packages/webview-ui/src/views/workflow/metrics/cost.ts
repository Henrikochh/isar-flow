/** Cost estimates from `isarFlow.modelPrices` (prices per 1 million tokens, keyed by model reference). */
import type { ModelPrice, ModelPrices, RunView, Usage } from '@isar-flow/core';
import { blockNumbers, count, isRecord } from './numbers';

export const COST_TITLE = 'Estimated from isarFlow.modelPrices';

function priceOf(model: string | undefined, prices: ModelPrices | undefined): ModelPrice | undefined {
  if (!model || !isRecord(prices) || !Object.hasOwn(prices, model)) return undefined;
  const price: unknown = prices[model];
  if (!isRecord(price)) return undefined;
  const input = count(price.input);
  const output = count(price.output);
  return input === undefined || output === undefined ? undefined : { input, output };
}

/** Estimated cost of `usage` with the model's price; undefined without usage or a valid price. */
export function estimateCost(
  usage: Partial<Usage> | undefined,
  model: string | undefined,
  prices: ModelPrices | undefined,
): number | undefined {
  const price = priceOf(model, prices);
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  if (!price || input === undefined || output === undefined) return undefined;
  return (input * price.input + output * price.output) / 1_000_000;
}

export interface RunCost {
  /** Sum over the blocks whose model has a price; undefined when none has. */
  cost?: number;
  /** Models that used tokens in this run but have no price, sorted. */
  unpriced: string[];
}

export function runCost(run: RunView, prices: ModelPrices | undefined): RunCost {
  let cost: number | undefined;
  const unpriced = new Set<string>();
  for (const view of Object.values(isRecord(run.steps) ? run.steps : {})) {
    const numbers = blockNumbers(view);
    if (!numbers?.model || !(numbers.inputTokens || numbers.outputTokens)) continue;
    const block = estimateCost(numbers, numbers.model, prices);
    if (block === undefined) unpriced.add(numbers.model);
    else cost = (cost ?? 0) + block;
  }
  return { cost, unpriced: [...unpriced].sort() };
}
