import {
  type ChatModel,
  type ChatModelInfo,
  ModelError,
  type ModelProbeResult,
  type OpenAICompatConfig,
  type ProbeOptions,
} from '@isar-flow/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PROBE_CACHE_KEY, PROBE_MAX_AGE_MS } from '../../../src/models/probeCache';
import { createModelRegistry, readModelSettings } from '../../../src/models/registry';

const NOW = 2_000_000_000_000;

class Memento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown) {
    this.values.set(key, value);
  }
}

function info(provider: string, id: string): ChatModelInfo {
  return {
    ref: `${provider}/${id}`,
    provider,
    providerLabel: provider,
    id,
    name: id,
    capabilities: { tools: true, jsonSchema: true },
  };
}

function probeResult(ref: string, outcome: ModelProbeResult['outcome'], testedAt = NOW): ModelProbeResult {
  const message = { tools: 'Tool calls work', text: 'Needs text tool mode', failed: 'It failed.' }[outcome];
  return { ref, outcome, message, toolCalls: outcome === 'tools', json: true, latencyMs: 800, testedAt };
}

type Lister = (cfg: OpenAICompatConfig) => Promise<ChatModelInfo[]>;

let configEmitter: vscode.EventEmitter<vscode.ConfigurationChangeEvent>;

beforeEach(() => {
  configEmitter = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
  vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation(configEmitter.event);
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(async () => undefined);
});

afterEach(() => vi.restoreAllMocks());

function setup(
  options: {
    prices?: unknown;
    listers?: Record<string, Lister>;
    store?: Memento;
    probe?: (model: ChatModel, options: ProbeOptions) => Promise<ModelProbeResult>;
  } = {},
) {
  const settings = {
    providers: [
      { id: 'litellm', baseUrl: 'http://localhost:4000' },
      { id: 'ollama', baseUrl: 'http://localhost:11434/v1' },
    ] as unknown,
    vscodeModels: false,
    prices: options.prices,
  };
  const store = options.store ?? new Memento();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const listModels = vi.fn(async (cfg: OpenAICompatConfig) =>
    (options.listers?.[cfg.id] ?? (async (c: OpenAICompatConfig) => [info(c.id, 'm')]))(cfg),
  );
  const chats: string[] = [];
  const createClient = vi.fn((cfg: OpenAICompatConfig) => ({
    listModels: () => listModels(cfg),
    model: (id: string): ChatModel => ({
      ...info(cfg.id, id),
      chat: () => {
        chats.push(`${cfg.id}/${id}`);
        return (async function* () {})();
      },
    }),
  }));
  const probe = vi.fn(
    options.probe ??
      (async (model: ChatModel) => probeResult(model.ref, model.id.includes('llama') ? 'text' : 'tools')),
  );
  const context = {
    secrets: { onDidChange: () => ({ dispose: () => undefined }), get: async () => undefined },
    globalState: store,
  } as unknown as vscode.ExtensionContext;
  const registry = createModelRegistry({
    context,
    log: log as unknown as vscode.LogOutputChannel,
    getConfig: () => settings,
    lm: { selectChatModels: async () => [], onDidChangeChatModels: () => ({ dispose: () => undefined }) },
    createClient,
    probeModel: probe,
    now: () => NOW,
  });
  return { registry, settings, store, log, probe, listModels, createClient, chats };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe('model registry probe', () => {
  it('tests a model, reports progress and caches the result', async () => {
    const gate = deferred<ModelProbeResult>();
    const { registry, store, probe } = setup({ probe: () => gate.promise });
    await registry.refresh();
    const seen: { probing?: string[]; probes?: Record<string, ModelProbeResult> }[] = [];
    registry.onDidChange(() => {
      const { probing, probes } = registry.catalog();
      seen.push({ probing, probes });
    });

    const pending = registry.probe('litellm/m');
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(registry.catalog().probing).toEqual(['litellm/m']);
    expect(seen[0]).toEqual({ probing: ['litellm/m'], probes: undefined });

    gate.resolve(probeResult('litellm/m', 'tools'));
    const result = await pending;

    expect(result.outcome).toBe('tools');
    expect(registry.catalog().probing).toBeUndefined();
    expect(registry.catalog().probes).toEqual({ 'litellm/m': result });
    expect(seen.at(-1)).toEqual({ probing: undefined, probes: { 'litellm/m': result } });
    expect(store.values.get(PROBE_CACHE_KEY)).toEqual({ 'litellm/m': result });
    expect(probe.mock.calls[0][0]).toMatchObject({ ref: 'litellm/m' });
  });

  it('runs one test per model at a time', async () => {
    const gate = deferred<ModelProbeResult>();
    const { registry, probe } = setup({ probe: () => gate.promise });
    const first = registry.probe('litellm/m');
    const second = registry.probe('litellm/m');
    gate.resolve(probeResult('litellm/m', 'tools'));
    expect(await first).toBe(await second);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('loads cached results of the last 30 days', () => {
    const store = new Memento();
    const fresh = probeResult('litellm/m', 'tools', NOW - 1000);
    store.values.set(PROBE_CACHE_KEY, {
      'litellm/m': fresh,
      'ollama/old': probeResult('ollama/old', 'text', NOW - PROBE_MAX_AGE_MS - 1),
    });
    const { registry } = setup({ store });
    expect(registry.catalog().probes).toEqual({ 'litellm/m': fresh });
  });

  it('does not cache a test the caller cancelled', async () => {
    const store = new Memento();
    const cached = probeResult('litellm/m', 'tools', NOW - 1000);
    store.values.set(PROBE_CACHE_KEY, { 'litellm/m': cached });
    const controller = new AbortController();
    const { registry } = setup({
      store,
      probe: async (_model, options) => {
        controller.abort();
        options.signal?.throwIfAborted();
        throw new Error('unreachable');
      },
    });
    const result = await registry.probe('litellm/m', controller.signal);
    expect(result).toMatchObject({ outcome: 'failed', message: 'The test was cancelled.' });
    expect(registry.catalog().probes).toEqual({ 'litellm/m': cached });
    expect(store.values.get(PROBE_CACHE_KEY)).toEqual({ 'litellm/m': cached });
  });

  it('reports models it cannot resolve without rejecting', async () => {
    const { registry, probe } = setup();
    const result = await registry.probe('gone/m');
    expect(result).toMatchObject({
      ref: 'gone/m',
      outcome: 'failed',
      message: "Unknown model provider 'gone' in 'gone/m'. Add it with 'Isar Flow: Add model endpoint'.",
      toolCalls: false,
      json: false,
      testedAt: NOW,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(registry.catalog().probes?.['gone/m']).toEqual(result);

    expect(await registry.probe('no-provider')).toMatchObject({ outcome: 'failed' });
  });

  it('reports unexpected probe failures without rejecting', async () => {
    const { registry } = setup({ probe: async () => Promise.reject(new Error('boom')) });
    expect(await registry.probe('litellm/m')).toMatchObject({ outcome: 'failed', message: 'boom' });
  });

  it('keeps the result when it cannot be stored', async () => {
    const store = new Memento();
    store.update = async () => Promise.reject(new Error('disk full'));
    const { registry, log } = setup({ store });
    expect((await registry.probe('litellm/m')).outcome).toBe('tools');
    expect(registry.catalog().probes?.['litellm/m']?.outcome).toBe('tools');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});

describe('model registry resolve after a test', () => {
  it('turns off native tool calls for models that need text tool mode', async () => {
    const { registry, chats } = setup();
    expect((await registry.resolve('ollama/llama3')).capabilities.tools).toBe(true);

    await registry.probe('ollama/llama3');
    const model = await registry.resolve('ollama/llama3');
    expect(model.capabilities).toEqual({ tools: false, jsonSchema: true });
    for await (const _event of model.chat([], {})) {
      // drain
    }
    expect(chats).toEqual(['ollama/llama3']);

    await registry.probe('litellm/m');
    expect((await registry.resolve('litellm/m')).capabilities.tools).toBe(true);
  });
});

describe('model registry prices', () => {
  it('lists valid prices and logs the invalid ones once', async () => {
    const { registry, log } = setup({
      prices: { 'litellm/m': { input: 2, output: 8 }, 'litellm/bad': { input: -1, output: 1 } },
    });
    await registry.refresh();
    await registry.refresh();
    expect(registry.catalog().prices).toEqual({ 'litellm/m': { input: 2, output: 8 } });
    const warnings = log.warn.mock.calls.filter(([m]) => String(m).includes('litellm/bad'));
    expect(warnings).toHaveLength(1);
  });

  it('updates prices when the setting changes, without listing models again', async () => {
    const { registry, settings, listModels } = setup();
    await registry.refresh();
    expect(registry.catalog().prices).toBeUndefined();
    listModels.mockClear();
    const changes = vi.fn();
    registry.onDidChange(changes);

    settings.prices = { 'ollama/m': { input: 0.5, output: 1 } };
    configEmitter.fire({ affectsConfiguration: (section) => section === 'isarFlow.modelPrices' });

    expect(changes).toHaveBeenCalledTimes(1);
    expect(registry.catalog().prices).toEqual({ 'ollama/m': { input: 0.5, output: 1 } });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('reads the setting', () => {
    const config = {
      get: <T>(key: string, fallback?: T) =>
        (key === 'modelPrices' ? { 'a/b': { input: 1, output: 2 } } : fallback) as T,
      inspect: () => undefined,
    };
    expect(readModelSettings(config, true).prices).toEqual({ 'a/b': { input: 1, output: 2 } });
  });
});

describe('model registry error kinds', () => {
  it('says why listing the models of an endpoint failed', async () => {
    const { registry } = setup({
      listers: {
        litellm: async () => Promise.reject(new ModelError('Authentication failed', 'auth', 401)),
        ollama: async () => Promise.reject(new Error('odd')),
      },
    });
    const catalog = await registry.refresh();
    expect(catalog.providers.map((p) => [p.id, p.status, p.errorKind])).toEqual([
      ['litellm', 'error', 'auth'],
      ['ollama', 'error', 'other'],
    ]);
  });

  it('has no error kind once listing works again', async () => {
    let fail = true;
    const { registry } = setup({
      listers: {
        litellm: async (c) => (fail ? Promise.reject(new ModelError('down', 'network')) : [info(c.id, 'm')]),
      },
    });
    expect((await registry.refresh()).providers[0].errorKind).toBe('network');
    fail = false;
    expect((await registry.refresh()).providers[0]).not.toHaveProperty('errorKind');
  });
});
