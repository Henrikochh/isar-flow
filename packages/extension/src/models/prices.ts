import type { ModelPrices } from '@isar-flow/core';
import { isRecord } from './settings';

const SETTING = 'isarFlow.modelPrices';

const isPrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Validates `isarFlow.modelPrices` (prices per 1 million tokens by model reference). Entries without
 * non-negative numbers for input and output are skipped; each problem is a sentence for the log.
 */
export function readModelPrices(raw: unknown): { prices: ModelPrices; problems: string[] } {
  const prices: ModelPrices = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { prices, problems };
  if (!isRecord(raw)) {
    problems.push(`The setting ${SETTING} must be an object of model references and prices; it is ignored.`);
    return { prices, problems };
  }
  for (const [key, value] of Object.entries(raw)) {
    const ref = key.trim();
    if (ref && isRecord(value) && isPrice(value.input) && isPrice(value.output)) {
      prices[ref] = { input: value.input, output: value.output };
    } else {
      problems.push(
        `The price of '${key}' in ${SETTING} is ignored: input and output must be numbers of 0 or more ` +
          '(per 1 million tokens).',
      );
    }
  }
  return { prices, problems };
}
