import { describe, expect, it } from 'vitest';
import type { ChatModel, ModelProbeResult } from '@isar-flow/core';
import { PROBE_MAX_AGE_MS, readProbeCache, withoutNativeTools } from '../../../src/models/probeCache';

const NOW = 1_000_000_000_000;

const result = (
  ref: string,
  testedAt = NOW,
  outcome: ModelProbeResult['outcome'] = 'tools',
): ModelProbeResult => ({
  ref,
  outcome,
  message: 'Tool calls work',
  toolCalls: true,
  json: true,
  latencyMs: 800,
  testedAt,
});

describe('readProbeCache', () => {
  it('keeps valid results from the last 30 days', () => {
    const fresh = result('a/fresh', NOW - PROBE_MAX_AGE_MS + 1);
    const old = result('a/old', NOW - PROBE_MAX_AGE_MS - 1);
    expect(readProbeCache({ 'a/fresh': fresh, 'a/old': old }, NOW)).toEqual({ 'a/fresh': fresh });
  });

  it('drops malformed entries and values', () => {
    const { latencyMs: _latency, ...withoutLatency } = result('a/b');
    const cache = readProbeCache(
      {
        'a/b': withoutLatency,
        'a/wrong-ref': result('a/other'),
        'a/bad-outcome': { ...result('a/bad-outcome'), outcome: 'great' },
        'a/no-message': { ...result('a/no-message'), message: 3 },
        'a/no-time': { ...result('a/no-time'), testedAt: 'yesterday' },
        'a/flags': { ...result('a/flags'), json: 'yes' },
        'a/latency': { ...result('a/latency'), latencyMs: -5 },
      },
      NOW,
    );
    expect(Object.keys(cache)).toEqual(['a/b']);
    expect(readProbeCache(undefined, NOW)).toEqual({});
    expect(readProbeCache([result('a/b')], NOW)).toEqual({});
  });
});

describe('withoutNativeTools', () => {
  class InstanceModel implements ChatModel {
    readonly ref = 'ollama/llama3';
    readonly provider = 'ollama';
    readonly providerLabel = 'Ollama';
    readonly id = 'llama3';
    readonly name = 'Llama 3';
    readonly family = 'llama';
    readonly maxInputTokens = 8000;
    readonly capabilities = { tools: true, jsonSchema: true };
    private readonly reply = 'bound';
    async *chat() {
      yield { type: 'text' as const, text: this.reply };
    }
  }

  it('reports no native tool calls and keeps chat bound to the model', async () => {
    const original = new InstanceModel();
    const wrapped = withoutNativeTools(original);
    expect(wrapped).toMatchObject({
      ref: 'ollama/llama3',
      provider: 'ollama',
      providerLabel: 'Ollama',
      id: 'llama3',
      name: 'Llama 3',
      family: 'llama',
      maxInputTokens: 8000,
      capabilities: { tools: false, jsonSchema: true },
    });
    expect(original.capabilities.tools).toBe(true);
    const events = [];
    for await (const event of wrapped.chat([], {})) events.push(event);
    expect(events).toEqual([{ type: 'text', text: 'bound' }]);
  });

  it('leaves out optional fields the model does not have', () => {
    const model: ChatModel = {
      ref: 'a/b',
      provider: 'a',
      providerLabel: 'A',
      id: 'b',
      name: 'b',
      capabilities: { tools: true, jsonSchema: false },
      chat: async function* () {},
    };
    expect(Object.keys(withoutNativeTools(model)).sort()).toEqual(
      ['capabilities', 'chat', 'id', 'name', 'provider', 'providerLabel', 'ref'].sort(),
    );
  });
});
