import type { ChatModel, ModelProbeOutcome, ModelProbeResult } from '@isar-flow/core';
import type * as vscode from 'vscode';
import { isRecord } from './settings';

/** globalState key of the cached "Test model" results, by model reference. */
export const PROBE_CACHE_KEY = 'isarFlow.modelProbes';
export const PROBE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const OUTCOMES: readonly ModelProbeOutcome[] = ['tools', 'text', 'failed'];

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function isProbeResult(ref: string, value: unknown): value is ModelProbeResult {
  return (
    isRecord(value) &&
    value.ref === ref &&
    OUTCOMES.includes(value.outcome as ModelProbeOutcome) &&
    typeof value.message === 'string' &&
    typeof value.toolCalls === 'boolean' &&
    typeof value.json === 'boolean' &&
    isTime(value.testedAt) &&
    (value.latencyMs === undefined || (isTime(value.latencyMs) && value.latencyMs >= 0))
  );
}

/** The valid results of the stored cache that are at most 30 days old. */
export function readProbeCache(raw: unknown, now: number): Record<string, ModelProbeResult> {
  const cache: Record<string, ModelProbeResult> = {};
  if (!isRecord(raw)) return cache;
  for (const [ref, value] of Object.entries(raw)) {
    if (isProbeResult(ref, value) && now - value.testedAt <= PROBE_MAX_AGE_MS) cache[ref] = value;
  }
  return cache;
}

/**
 * The model as agents see it once its test said "Needs text tool mode": no native tool calls, so toolMode auto
 * describes the tools in the prompt. Copies fields instead of spreading, because models may be class instances.
 */
export function withoutNativeTools(model: ChatModel): ChatModel {
  const wrapped: ChatModel = {
    ref: model.ref,
    provider: model.provider,
    providerLabel: model.providerLabel,
    id: model.id,
    name: model.name,
    capabilities: { ...model.capabilities, tools: false },
    chat: (messages, options) => model.chat(messages, options),
  };
  if (model.family !== undefined) wrapped.family = model.family;
  if (model.maxInputTokens !== undefined) wrapped.maxInputTokens = model.maxInputTokens;
  return wrapped;
}

type ProbeStore = Pick<vscode.Memento, 'get' | 'update'>;

/** The cached "Test model" results, read from the store on first use and written back after every test. */
export class ProbeResults {
  private cache: Record<string, ModelProbeResult> | undefined;

  constructor(
    private readonly store: ProbeStore | undefined,
    private readonly now: () => number,
    private readonly log: Pick<vscode.LogOutputChannel, 'warn'>,
  ) {}

  all(): Record<string, ModelProbeResult> {
    if (!this.cache) {
      let stored: unknown;
      try {
        stored = this.store?.get<unknown>(PROBE_CACHE_KEY);
      } catch (error) {
        this.log.warn(`Could not read the stored model test results: ${messageOf(error)}`);
      }
      this.cache = readProbeCache(stored, this.now());
    }
    return this.cache;
  }

  async remember(result: ModelProbeResult): Promise<void> {
    const cache = readProbeCache({ ...this.all(), [result.ref]: result }, this.now());
    this.cache = cache;
    try {
      await this.store?.update(PROBE_CACHE_KEY, cache);
    } catch (error) {
      this.log.warn(`Could not store the test result of ${result.ref}: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
