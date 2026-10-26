import { type ChatModel, type ChatModelInfo, ModelError, type OpenAICompatConfig } from '@isar-flow/core';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import * as vscode from 'vscode';
import { createModelRegistry } from '../../../src/models/registry';

/* ---------- fakes ---------- */

class FakeSecrets {
  readonly values = new Map<string, string>();
  readonly changes = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  readonly onDidChange = this.changes.event;
  async get(key: string) {
    return this.values.get(key);
  }
  async store(key: string, value: string) {
    this.values.set(key, value);
    this.changes.fire({ key });
  }
  async delete(key: string) {
    this.values.delete(key);
    this.changes.fire({ key });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function info(provider: string, id: string, label = provider): ChatModelInfo {
  return {
    ref: `${provider}/${id}`,
    provider,
    providerLabel: label,
    id,
    name: id,
    capabilities: { tools: true, jsonSchema: true },
  };
}

function lmModel(vendor: string, id: string, name: string, family = id): vscode.LanguageModelChat {
  return {
    vendor,
    id,
    name,
    family,
    version: '1',
    maxInputTokens: 1000,
    sendRequest: async () => {
      throw new Error('not used');
    },
    countTokens: async () => 0,
  };
}

type Lister = (cfg: OpenAICompatConfig, signal?: AbortSignal) => Promise<ChatModelInfo[]>;

interface Setup {
  providers?: unknown;
  vscodeModels?: boolean;
  lmModels?: vscode.LanguageModelChat[];
  listers?: Record<string, Lister>;
}

const created: OpenAICompatConfig[] = [];
let configEmitter: vscode.EventEmitter<vscode.ConfigurationChangeEvent>;
let warnings: Mock<(message: string) => Promise<undefined>>;

function setup(options: Setup = {}) {
  const settings = { providers: options.providers ?? [], vscodeModels: options.vscodeModels ?? true };
  const getConfig = vi.fn(() => settings);
  const secrets = new FakeSecrets();
  const lmChanges = new vscode.EventEmitter<void>();
  const lmModels = options.lmModels ?? [];
  const selectChatModels = vi.fn(async (selector?: vscode.LanguageModelChatSelector) =>
    lmModels.filter(
      (m) => (!selector?.vendor || m.vendor === selector.vendor) && (!selector?.id || m.id === selector.id),
    ),
  );
  const lm = { selectChatModels, onDidChangeChatModels: lmChanges.event };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
  const listers = options.listers ?? {};
  const createClient = vi.fn((cfg: OpenAICompatConfig) => {
    created.push(cfg);
    return {
      listModels: (signal?: AbortSignal) =>
        (listers[cfg.id] ?? (async (c: OpenAICompatConfig) => [info(c.id, 'default', c.label)]))(cfg, signal),
      model: (id: string): ChatModel => ({ ...info(cfg.id, id, cfg.label), chat: async function* () {} }),
    };
  });
  const context = { secrets, subscriptions: [] } as unknown as vscode.ExtensionContext;
  const registry = createModelRegistry({
    context,
    log: log as unknown as vscode.LogOutputChannel,
    getConfig,
    lm,
    createClient,
  });
  return { registry, settings, getConfig, secrets, lm, lmChanges, log, createClient, selectChatModels };
}

function configChange(...sections: string[]): vscode.ConfigurationChangeEvent {
  return { affectsConfiguration: (section: string) => sections.includes(section) };
}

beforeEach(() => {
  created.length = 0;
  configEmitter = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
  vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation(configEmitter.event);
  warnings = vi.fn(async (_message: string) => undefined);
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(warnings);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ---------- tests ---------- */

describe('model registry catalog', () => {
  it('lists VS Code models first, then each endpoint, sorted by name', async () => {
    const { registry, secrets } = setup({
      providers: [
        {
          id: 'litellm',
          label: 'LiteLLM',
          baseUrl: 'http://localhost:4000',
          models: ['extra'],
          headers: { 'X-A': '1' },
        },
        { id: 'ollama', baseUrl: 'http://localhost:11434/v1', discoverModels: false },
      ],
      lmModels: [
        lmModel('copilot', 'gpt-4.1', 'GPT-4.1'),
        lmModel('copilot', 'claude-sonnet-4', 'Claude Sonnet 4'),
      ],
      listers: {
        litellm: async (c) => [info(c.id, 'gpt-4.1', c.label), info(c.id, 'claude', c.label)],
        ollama: async (c) => [info(c.id, 'llama3', c.label)],
      },
    });
    await secrets.store('isarFlow.provider.litellm.apiKey', 'sk-1');

    const catalog = await registry.refresh();

    expect(catalog.loading).toBe(false);
    expect(catalog.providers).toEqual([
      { id: 'vscode', label: 'VS Code', kind: 'vscode', hasApiKey: false, status: 'ok', modelCount: 2 },
      {
        id: 'litellm',
        label: 'LiteLLM',
        kind: 'openai-compatible',
        baseUrl: 'http://localhost:4000',
        hasApiKey: true,
        status: 'ok',
        modelCount: 2,
      },
      {
        id: 'ollama',
        label: 'ollama',
        kind: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        hasApiKey: false,
        status: 'ok',
        modelCount: 1,
      },
    ]);
    expect(catalog.models.map((m) => m.ref)).toEqual([
      'vscode/copilot/claude-sonnet-4',
      'vscode/copilot/gpt-4.1',
      'litellm/claude',
      'litellm/gpt-4.1',
      'ollama/llama3',
    ]);
    expect(registry.catalog()).toEqual(catalog);

    const litellm = created.find((c) => c.id === 'litellm');
    expect(litellm).toMatchObject({
      label: 'LiteLLM',
      baseUrl: 'http://localhost:4000',
      apiKey: 'sk-1',
      models: ['extra'],
      headers: { 'X-A': '1' },
    });
    expect(created.find((c) => c.id === 'ollama')).toMatchObject({
      apiKey: undefined,
      discoverModels: false,
    });
  });

  it('isolates provider errors', async () => {
    const { registry, log } = setup({
      providers: [
        { id: 'down', baseUrl: 'http://localhost:1' },
        { id: 'up', baseUrl: 'http://localhost:2' },
      ],
      listers: {
        down: async () => {
          throw new ModelError('Cannot reach http://localhost:1. Is the server running?', 'network');
        },
      },
    });

    const catalog = await registry.refresh();

    const down = catalog.providers.find((p) => p.id === 'down');
    expect(down).toMatchObject({
      status: 'error',
      error: 'Cannot reach http://localhost:1. Is the server running?',
      modelCount: 0,
    });
    expect(catalog.providers.find((p) => p.id === 'up')).toMatchObject({ status: 'ok', modelCount: 1 });
    expect(catalog.models.map((m) => m.ref)).toEqual(['up/default']);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Cannot reach'));
  });

  it('reports a failing VS Code model listing without hiding endpoints', async () => {
    const { registry, selectChatModels } = setup({ providers: [{ id: 'a', baseUrl: 'http://a' }] });
    selectChatModels.mockRejectedValueOnce(new Error('LM service unavailable'));

    const catalog = await registry.refresh();

    expect(catalog.providers[0]).toMatchObject({
      id: 'vscode',
      status: 'error',
      error: 'LM service unavailable',
    });
    expect(catalog.providers[1]).toMatchObject({ id: 'a', status: 'ok' });
  });

  it('leaves out VS Code models when the setting is off', async () => {
    const { registry, selectChatModels } = setup({
      vscodeModels: false,
      lmModels: [lmModel('copilot', 'x', 'X')],
    });
    const catalog = await registry.refresh();
    expect(catalog.providers).toEqual([]);
    expect(catalog.models).toEqual([]);
    expect(selectChatModels).not.toHaveBeenCalled();
  });

  it('starts loading lazily on the first catalog() call and reports progress', async () => {
    const listing = deferred<ChatModelInfo[]>();
    const { registry, createClient } = setup({
      providers: [{ id: 'slow', baseUrl: 'http://slow' }],
      listers: { slow: () => listing.promise },
    });
    const changes = vi.fn();
    registry.onDidChange(changes);
    expect(createClient).not.toHaveBeenCalled();

    const first = registry.catalog();
    expect(first.loading).toBe(true);
    expect(first.providers.find((p) => p.id === 'slow')?.status).toBe('loading');
    expect(changes).toHaveBeenCalled();

    listing.resolve([info('slow', 'm')]);
    await vi.waitFor(() => expect(registry.catalog().loading).toBe(false));
    expect(registry.catalog().providers.find((p) => p.id === 'slow')?.status).toBe('ok');
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('applies only the newest refresh', async () => {
    const slow = deferred<ChatModelInfo[]>();
    const listing = deferred<void>();
    const { registry, settings } = setup({
      vscodeModels: false,
      providers: [{ id: 'old', baseUrl: 'http://old' }],
      listers: {
        old: () => {
          listing.resolve();
          return slow.promise;
        },
      },
    });
    const first = registry.refresh();
    await listing.promise;
    settings.providers = [{ id: 'new', baseUrl: 'http://new' }];
    const second = registry.refresh();
    slow.resolve([info('old', 'stale')]);

    const [a, b] = await Promise.all([first, second]);
    expect(b.providers.map((p) => p.id)).toEqual(['new']);
    expect(a).toEqual(b);
    expect(registry.catalog().models.map((m) => m.ref)).toEqual(['new/default']);
  });
});

describe('model registry resolve', () => {
  it('resolves VS Code models by vendor and id', async () => {
    const { registry, selectChatModels } = setup({ lmModels: [lmModel('copilot', 'gpt-4.1', 'GPT-4.1')] });
    const model = await registry.resolve('vscode/copilot/gpt-4.1');
    expect(model.ref).toBe('vscode/copilot/gpt-4.1');
    expect(model.name).toBe('GPT-4.1');
    expect(selectChatModels).toHaveBeenCalledWith({ vendor: 'copilot', id: 'gpt-4.1' });
  });

  it('lists the vendor once more when the exact model is not found', async () => {
    const { registry, selectChatModels } = setup({
      lmModels: [lmModel('copilot', 'gpt-4.1-2025', 'GPT-4.1', 'gpt-4.1')],
    });
    const model = await registry.resolve('vscode/copilot/gpt-4.1');
    expect(model.ref).toBe('vscode/copilot/gpt-4.1-2025');
    expect(selectChatModels).toHaveBeenCalledWith({ vendor: 'copilot' });
  });

  it('fails with not-found when VS Code has no such model', async () => {
    const { registry } = setup();
    await expect(registry.resolve('vscode/copilot/nope')).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('refuses VS Code models when they are turned off', async () => {
    const { registry } = setup({ vscodeModels: false, lmModels: [lmModel('copilot', 'x', 'X')] });
    await expect(registry.resolve('vscode/copilot/x')).rejects.toMatchObject({
      kind: 'not-found',
      message: expect.stringContaining('isarFlow.vscodeModels'),
    });
  });

  it('resolves endpoint models even when they were not listed', async () => {
    const { registry, secrets } = setup({ providers: [{ id: 'litellm', baseUrl: 'http://localhost:4000' }] });
    await secrets.store('isarFlow.provider.litellm.apiKey', 'sk-9');
    const model = await registry.resolve('litellm/openai/gpt-4.1');
    expect(model.ref).toBe('litellm/openai/gpt-4.1');
    expect(model.id).toBe('openai/gpt-4.1');
    expect(created.at(-1)?.apiKey).toBe('sk-9');
  });

  it('names unknown providers and how to add them', async () => {
    const { registry } = setup();
    const error = await registry.resolve('x/y').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      kind: 'not-found',
      message: "Unknown model provider 'x' in 'x/y'. Add it with 'Isar Flow: Add model endpoint'.",
    });
  });

  it('rejects references without a provider', async () => {
    const { registry } = setup();
    await expect(registry.resolve('gpt-4.1')).rejects.toThrow(/Invalid model reference/);
  });
});

describe('model registry updates', () => {
  it('refreshes when its settings change', async () => {
    const { registry, settings } = setup({ vscodeModels: false });
    await registry.refresh();
    const changes = vi.fn();
    registry.onDidChange(changes);

    configEmitter.fire(configChange('editor.fontSize'));
    expect(changes).not.toHaveBeenCalled();

    settings.providers = [{ id: 'fresh', baseUrl: 'http://fresh' }];
    configEmitter.fire(configChange('isarFlow.providers', 'isarFlow'));
    await vi.waitFor(() => expect(registry.catalog().providers.map((p) => p.status)).toEqual(['ok']));
    expect(registry.catalog().providers[0].id).toBe('fresh');

    settings.vscodeModels = true;
    configEmitter.fire(configChange('isarFlow.vscodeModels'));
    await vi.waitFor(() => expect(registry.catalog().providers[0].id).toBe('vscode'));
  });

  it('does not load anything for changes before it was used', async () => {
    const { getConfig, secrets, lmChanges } = setup({ providers: [{ id: 'a', baseUrl: 'http://a' }] });
    configEmitter.fire(configChange('isarFlow.providers'));
    await secrets.store('isarFlow.provider.a.apiKey', 'x');
    lmChanges.fire();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('refreshes when a provider API key changes', async () => {
    const { registry, secrets } = setup({ providers: [{ id: 'a', baseUrl: 'http://a' }] });
    await registry.refresh();
    const changes = vi.fn();
    registry.onDidChange(changes);

    await secrets.store('isarFlow.secret.TOKEN', 'x');
    expect(changes).not.toHaveBeenCalled();

    await secrets.store('isarFlow.provider.a.apiKey', 'sk-new');
    await vi.waitFor(() =>
      expect(registry.catalog().providers.find((p) => p.id === 'a')?.hasApiKey).toBe(true),
    );
    expect(created.at(-1)?.apiKey).toBe('sk-new');
  });

  it('re-lists VS Code models once after changes settle', async () => {
    vi.useFakeTimers();
    const models = [lmModel('copilot', 'a', 'A')];
    const { registry, lmChanges, selectChatModels } = setup({ lmModels: models });
    await registry.refresh();
    selectChatModels.mockClear();

    models.push(lmModel('copilot', 'b', 'B'));
    lmChanges.fire();
    lmChanges.fire();
    await vi.advanceTimersByTimeAsync(200);
    lmChanges.fire();
    await vi.advanceTimersByTimeAsync(299);
    expect(selectChatModels).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(selectChatModels).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(registry.catalog().models.map((m) => m.ref)).toEqual(['vscode/copilot/a', 'vscode/copilot/b']),
    );
  });

  it('logs settings problems and shows each one once', async () => {
    const { registry, log, settings } = setup({
      vscodeModels: false,
      providers: [
        { id: 'Bad', baseUrl: 'http://x' },
        { id: 'ok', baseUrl: 'http://ok' },
      ],
    });
    await registry.refresh();
    await registry.refresh();
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0][0]).toContain("'Bad'");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("'Bad'"));

    settings.providers = [{ id: 'ok', baseUrl: 'http://ok' }];
    await registry.refresh();
    settings.providers = [{ id: 'Bad', baseUrl: 'http://x' }];
    await registry.refresh();
    expect(warnings).toHaveBeenCalledTimes(2);
  });

  it('stops listening when disposed', async () => {
    const { registry, getConfig, secrets, lmChanges } = setup({
      providers: [{ id: 'a', baseUrl: 'http://a' }],
    });
    await registry.refresh();
    getConfig.mockClear();
    registry.dispose();

    configEmitter.fire(configChange('isarFlow.providers'));
    await secrets.store('isarFlow.provider.a.apiKey', 'x');
    lmChanges.fire();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(getConfig).not.toHaveBeenCalled();
  });
});
