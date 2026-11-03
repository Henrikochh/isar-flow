import { describe, expect, it } from 'vitest';
import { readModelPrices } from '../../../src/models/prices';

describe('readModelPrices', () => {
  it('keeps entries with input and output prices of 0 or more', () => {
    const { prices, problems } = readModelPrices({
      'litellm/gpt-4.1': { input: 2, output: 8 },
      ' ollama/llama3 ': { input: 0, output: 0, note: 'local' },
    });
    expect(prices).toEqual({
      'litellm/gpt-4.1': { input: 2, output: 8 },
      'ollama/llama3': { input: 0, output: 0 },
    });
    expect(problems).toEqual([]);
  });

  it('skips invalid entries and names them', () => {
    const { prices, problems } = readModelPrices({
      'a/negative': { input: -1, output: 2 },
      'a/text': { input: '2', output: 8 },
      'a/missing': { input: 2 },
      'a/infinite': { input: Infinity, output: 1 },
      'a/list': [1, 2],
      '': { input: 1, output: 1 },
      'a/ok': { input: 1.5, output: 3 },
    });
    expect(prices).toEqual({ 'a/ok': { input: 1.5, output: 3 } });
    expect(problems).toHaveLength(6);
    expect(problems[0]).toBe(
      "The price of 'a/negative' in isarFlow.modelPrices is ignored: input and output must be numbers of 0 or more (per 1 million tokens).",
    );
  });

  it('treats a missing setting as no prices and a malformed one as a problem', () => {
    expect(readModelPrices(undefined)).toEqual({ prices: {}, problems: [] });
    expect(readModelPrices(null)).toEqual({ prices: {}, problems: [] });
    expect(readModelPrices([1])).toEqual({
      prices: {},
      problems: [
        'The setting isarFlow.modelPrices must be an object of model references and prices; it is ignored.',
      ],
    });
  });
});
