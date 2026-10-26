import {
  type ChatModelInfo,
  type ModelCatalog,
  ModelError,
  type OpenAICompatConfig,
  type ProviderSummary,
} from '@isar-flow/core';
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  type CommandUi,
  createProviderCommands,
  type InputOptions,
  type ProviderSettingsStore,
} from '../../../src/models/providerCommands';

/* ---------- fakes ---------- */

type Answer = (items: vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined;

const byLabel =
  (text: string): Answer =>
  (items) =>
    items.find((i) => i.label.includes(text));

class FakeUi implements CommandUi {
  readonly picks: Answer[] = [];
  readonly inputs: (string | undefined)[] = [];
  readonly pickCalls: { items: vscode.QuickPickItem[]; title: string; placeHolder?: string }[] = [];
  readonly inputCalls: InputOptions[] = [];
  readonly infos: string[] = [];
  readonly errors: string[] = [];
  readonly confirms: string[] = [];
  readonly progressTitles: string[] = [];
  readonly openedSettings: string[] = [];
  infoAnswer: string | undefined;
  errorAnswers: (string | undefined)[] = [];
  confirmAnswer = true;

  async pick<T extends vscode.QuickPickItem>(items: T[], options: { title: string; placeHolder?: string }) {
    this.pickCalls.push({ items, ...options });
    return this.picks.shift()?.(items) as T | undefined;
  }
  async input(options: InputOptions) {
    this.inputCalls.push(options);
    return this.inputs.shift();
  }
  async info(message: string) {
    this.infos.push(message);
    return this.infoAnswer;
  }
  async error(message: string) {
    this.errors.push(message);
    return this.errorAnswers.shift();
  }
  async confirm(message: string) {
    this.confirms.push(message);
    return this.confirmAnswer;
  }
  async progress<T>(title: string, task: (signal: AbortSignal) => Promise<T>) {
    this.progressTitles.push(title);
    return task(new AbortController().signal);
  }
  openSettings(query: string) {
    this.openedSettings.push(query);
  }
}

class FakeSettings implements ProviderSettingsStore {
  constructor(public stored: unknown[] = []) {}
  saves = 0;
  entries() {
    return [...this.stored];
  }
  async save(entries: unknown[]) {
    this.saves++;
    this.stored = entries;
  }
}

class FakeSecrets {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key);
  }
  async store(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

function summary(id: string, change: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id,
    label: id,
    kind: 'openai-compatible',
    hasApiKey: false,
    status: 'ok',
    modelCount: 3,
    ...change,
  };
}

function model(id: string): ChatModelInfo {
  return {
    ref: `p/${id}`,
    provider: 'p',
    providerLabel: 'P',
    id,
    name: id,
    capabilities: { tools: true, jsonSchema: true },
  };
}

function setup(stored: unknown[] = [], providers: ProviderSummary[] = []) {
  const ui = new FakeUi();
  const settings = new FakeSettings(stored);
  const secrets = new FakeSecrets();
  const catalog: ModelCatalog = { models: [], providers, loading: false };
  const registry = { catalog: vi.fn(() => catalog), refresh: vi.fn(async () => catalog) };
  let listModels: (signal?: AbortSignal) => Promise<ChatModelInfo[]> = async () => [model('a'), model('b')];
  const clients: OpenAICompatConfig[] = [];
  const createClient = vi.fn((cfg: OpenAICompatConfig) => {
    clients.push(cfg);
    return { listModels: (signal?: AbortSignal) => listModels(signal) };
  });
  const commands = createProviderCommands({ registry, secrets, settings, ui, createClient });
  return {
    ui,
    settings,
    secrets,
    catalog,
    registry,
    clients,
    commands,
    setListModels: (fn: typeof listModels) => (listModels = fn),
  };
}

/* ---------- add ---------- */

describe('add model endpoint', () => {
  it('adds a preset endpoint with its API key and reports the models', async () => {
    const { ui, settings, secrets, registry, catalog, commands } = setup();
    catalog.providers.push(summary('litellm', { label: 'LiteLLM', modelCount: 8 }));
    ui.picks.push(byLabel('LiteLLM'));
    ui.inputs.push('litellm', 'http://localhost:4000', ' sk-1 ');

    await commands.addProvider();

    expect(ui.inputCalls[0].value).toBe('litellm');
    expect(ui.inputCalls[1].value).toBe('http://localhost:4000');
    expect(ui.inputCalls[2].password).toBe(true);
    expect(settings.stored).toEqual([{ id: 'litellm', label: 'LiteLLM', baseUrl: 'http://localhost:4000' }]);
    expect(secrets.values.get('isarFlow.provider.litellm.apiKey')).toBe('sk-1');
    expect(registry.refresh).toHaveBeenCalled();
    expect(ui.infos).toEqual(['Added LiteLLM with 8 models.']);
  });

  it('offers every preset', async () => {
    const { ui, commands } = setup();
    await commands.addProvider();
    const items = ui.pickCalls[0].items;
    expect(items.map((i) => i.label)).toEqual(['LiteLLM', 'Ollama', 'OpenRouter', 'OpenAI', 'Custom…']);
    expect(items.map((i) => i.description)).toEqual([
      'http://localhost:4000',
      'http://localhost:11434/v1',
      'https://openrouter.ai/api/v1',
      'https://api.openai.com/v1',
      undefined,
    ]);
  });

  it('does not ask Ollama for an API key', async () => {
    const { ui, settings, catalog, commands } = setup();
    catalog.providers.push(summary('ollama', { label: 'Ollama', modelCount: 1 }));
    ui.picks.push(byLabel('Ollama'));
    ui.inputs.push('ollama', 'http://localhost:11434/v1');

    await commands.addProvider();

    expect(ui.inputCalls).toHaveLength(2);
    expect(settings.stored).toEqual([
      { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
    ]);
    expect(ui.infos).toEqual(['Added Ollama with 1 model.']);
  });

  it('suggests a free id and validates the input', async () => {
    const { ui, commands } = setup([{ id: 'litellm', label: 'LiteLLM', baseUrl: 'http://a' }]);
    ui.picks.push(byLabel('LiteLLM'));
    await commands.addProvider();

    const idInput = ui.inputCalls[0];
    expect(idInput.value).toBe('litellm-2');
    expect(idInput.validate?.('litellm')).toMatch(/already exists/);
    expect(idInput.validate?.('Bad')).toMatch(/lowercase/);
    expect(idInput.validate?.('litellm-2')).toBeUndefined();
  });

  it('labels a second endpoint of the same kind by its id', async () => {
    const { ui, settings, commands } = setup([{ id: 'litellm', label: 'LiteLLM', baseUrl: 'http://a' }]);
    ui.picks.push(byLabel('LiteLLM'));
    ui.inputs.push('litellm-2', 'http://b', '');
    await commands.addProvider();
    expect(settings.stored[1]).toEqual({
      id: 'litellm-2',
      label: 'LiteLLM (litellm-2)',
      baseUrl: 'http://b',
    });
  });

  it('asks for every field of a custom endpoint', async () => {
    const { ui, settings, secrets, commands } = setup();
    secrets.values.set('isarFlow.provider.vllm.apiKey', 'stale');
    ui.picks.push(byLabel('Custom'));
    ui.inputs.push('vllm', 'http://gpu:8000/v1', '');
    await commands.addProvider();

    expect(ui.inputCalls[0].value).toBe('');
    expect(ui.inputCalls[1].validate?.('gpu:8000')).toMatch(/http:\/\//);
    expect(settings.stored).toEqual([{ id: 'vllm', baseUrl: 'http://gpu:8000/v1' }]);
    expect(secrets.values.has('isarFlow.provider.vllm.apiKey')).toBe(false);
  });

  it('writes nothing when cancelled', async () => {
    const { ui, settings, secrets, commands } = setup();
    ui.picks.push(byLabel('OpenAI'));
    ui.inputs.push('openai', 'https://api.openai.com/v1', undefined);
    await commands.addProvider();
    expect(settings.saves).toBe(0);
    expect(secrets.values.size).toBe(0);
  });

  it('reports a listing error and offers to edit the endpoint', async () => {
    const { ui, catalog, commands } = setup();
    catalog.providers.push(
      summary('litellm', { label: 'LiteLLM', status: 'error', error: 'Cannot reach it.' }),
    );
    ui.picks.push(byLabel('LiteLLM'));
    ui.inputs.push('litellm', 'http://localhost:4000', '');
    ui.errorAnswers.push('Edit endpoint');

    await commands.addProvider();

    expect(ui.errors).toEqual(['Added LiteLLM, but its models could not be listed: Cannot reach it.']);
    expect(ui.pickCalls[1].title).toBe('Edit model endpoint: LiteLLM');
    expect(ui.pickCalls[1].placeHolder).toBe('Cannot reach it.');
  });
});

/* ---------- edit ---------- */

describe('edit model endpoint', () => {
  it('changes the base URL and keeps other fields', async () => {
    const { ui, settings, commands } = setup([
      { id: 'a', baseUrl: 'http://old', headers: { X: '1' } },
      { id: 'b', baseUrl: 'http://b' },
    ]);
    ui.picks.push(byLabel('Base URL'));
    ui.inputs.push('http://new/v1');

    await commands.editProvider('a');

    expect(settings.stored).toEqual([
      { id: 'a', baseUrl: 'http://new/v1', headers: { X: '1' } },
      { id: 'b', baseUrl: 'http://b' },
    ]);
  });

  it('edits the extra model list', async () => {
    const { ui, settings, commands } = setup([{ id: 'a', baseUrl: 'http://a', models: ['x'] }]);
    ui.picks.push(byLabel('Extra models'), byLabel('Extra models'));
    ui.inputs.push(' gpt-4.1, llama3:8b ,, ', '');

    await commands.editProvider('a');
    expect(ui.inputCalls[0].value).toBe('x');
    expect(settings.stored).toEqual([{ id: 'a', baseUrl: 'http://a', models: ['gpt-4.1', 'llama3:8b'] }]);

    await commands.editProvider('a');
    expect(settings.stored).toEqual([{ id: 'a', baseUrl: 'http://a' }]);
  });

  it('renames the endpoint and drops an empty name', async () => {
    const { ui, settings, commands } = setup([{ id: 'a', label: 'Old', baseUrl: 'http://a' }]);
    ui.picks.push(byLabel('Name'));
    ui.inputs.push('');
    await commands.editProvider('a');
    expect(settings.stored).toEqual([{ id: 'a', baseUrl: 'http://a' }]);
  });

  it('asks which endpoint to edit when none is given, even with broken settings', async () => {
    const { ui, commands } = setup(
      [{ id: 'a', baseUrl: 'not a url' }, { id: 'b', label: 'B', baseUrl: 'http://b' }, 'junk'],
      [summary('b', { label: 'B', modelCount: 2, hasApiKey: true })],
    );
    await commands.editProvider();
    expect(ui.pickCalls[0].items.map((i) => [i.label, i.detail])).toEqual([
      ['a', 'Not loaded: check its settings'],
      ['B', '2 models · API key stored'],
    ]);
  });

  it('offers to add an endpoint when there is none', async () => {
    const { ui, commands } = setup();
    ui.infoAnswer = 'Add model endpoint';
    await commands.editProvider();
    expect(ui.infos[0]).toMatch(/No model endpoints/);
    expect(ui.pickCalls[0].title).toBe('Add model endpoint');
  });

  it('explains that VS Code models need no setup', async () => {
    const { ui, commands } = setup();
    ui.infoAnswer = 'Open setting';
    await commands.editProvider('vscode');
    expect(ui.infos[0]).toMatch(/GitHub Copilot/);
    expect(ui.openedSettings).toEqual(['isarFlow.vscodeModels']);
  });
});

/* ---------- remove, key, test, refresh ---------- */

describe('remove model endpoint', () => {
  it('removes the entry and its API key after confirmation', async () => {
    const { ui, settings, secrets, commands } = setup([
      { id: 'a', baseUrl: 'http://a' },
      { id: 'b', baseUrl: 'http://b' },
    ]);
    secrets.values.set('isarFlow.provider.a.apiKey', 'k');
    await commands.removeProvider('a');
    expect(ui.confirms[0]).toContain("'a'");
    expect(settings.stored).toEqual([{ id: 'b', baseUrl: 'http://b' }]);
    expect(secrets.values.size).toBe(0);
  });

  it('keeps everything when not confirmed', async () => {
    const { ui, settings, secrets, commands } = setup([{ id: 'a', baseUrl: 'http://a' }]);
    secrets.values.set('isarFlow.provider.a.apiKey', 'k');
    ui.confirmAnswer = false;
    await commands.removeProvider('a');
    expect(settings.saves).toBe(0);
    expect(secrets.values.size).toBe(1);
  });

  it('says so when the endpoint does not exist', async () => {
    const { ui, settings, commands } = setup([{ id: 'a', baseUrl: 'http://a' }]);
    await commands.removeProvider('zzz');
    expect(ui.errors[0]).toContain("'zzz'");
    expect(settings.saves).toBe(0);
  });
});

describe('set provider API key', () => {
  it('stores a new key and reports the models', async () => {
    const { ui, secrets, catalog, commands } = setup([{ id: 'a', label: 'A', baseUrl: 'http://a' }]);
    catalog.providers.push(summary('a', { label: 'A', modelCount: 2 }));
    ui.inputs.push('  sk-2  ');
    await commands.setProviderKey('a');
    expect(ui.inputCalls[0].password).toBe(true);
    expect(secrets.values.get('isarFlow.provider.a.apiKey')).toBe('sk-2');
    expect(ui.infos).toEqual(['Saved the API key of A. 2 models are available.']);
  });

  it('removes the stored key when left empty', async () => {
    const { ui, secrets, commands } = setup([{ id: 'a', label: 'A', baseUrl: 'http://a' }]);
    secrets.values.set('isarFlow.provider.a.apiKey', 'old');
    ui.inputs.push('');
    await commands.setProviderKey('a');
    expect(secrets.values.size).toBe(0);
    expect(ui.infos).toEqual(['Removed the API key of A.']);
  });
});

describe('test model endpoint', () => {
  it('lists models without the manual list so errors surface', async () => {
    const { ui, secrets, clients, commands } = setup([
      {
        id: 'a',
        label: 'A',
        baseUrl: 'http://a',
        models: ['manual'],
        discoverModels: false,
        headers: { X: '1' },
      },
    ]);
    secrets.values.set('isarFlow.provider.a.apiKey', 'sk');
    await commands.testProvider('a');
    expect(clients[0]).toMatchObject({
      id: 'a',
      label: 'A',
      baseUrl: 'http://a',
      apiKey: 'sk',
      headers: { X: '1' },
      discoverModels: true,
    });
    expect(clients[0].models).toBeUndefined();
    expect(ui.infos).toEqual(['A works: 2 models are available (a, b).']);
  });

  it('shows the error and offers to edit', async () => {
    const { ui, commands, setListModels } = setup([{ id: 'a', label: 'A', baseUrl: 'http://a' }]);
    setListModels(async () => {
      throw new ModelError("Authentication failed for provider 'A' (HTTP 401).", 'auth', 401);
    });
    ui.errorAnswers.push('Edit endpoint');
    await commands.testProvider('a');
    expect(ui.errors).toEqual(["Testing A failed: Authentication failed for provider 'A' (HTTP 401)."]);
    expect(ui.pickCalls[0].title).toBe('Edit model endpoint: A');
  });

  it('stays quiet when the test was cancelled', async () => {
    const { ui, commands, setListModels } = setup([{ id: 'a', baseUrl: 'http://a' }]);
    setListModels(async () => {
      throw new ModelError('cancelled', 'aborted');
    });
    await commands.testProvider('a');
    expect(ui.errors).toEqual([]);
  });

  it('refuses an endpoint without a valid base URL', async () => {
    const { ui, clients, commands } = setup([{ id: 'a', baseUrl: 'localhost' }]);
    await commands.testProvider('a');
    expect(clients).toEqual([]);
    expect(ui.errors[0]).toMatch(/base URL/);
  });

  it('reports the VS Code models', async () => {
    const { ui, catalog, commands } = setup(
      [],
      [summary('vscode', { label: 'VS Code', kind: 'vscode', modelCount: 12 })],
    );
    await commands.testProvider('vscode');
    expect(catalog.providers).toHaveLength(1);
    expect(ui.infos).toEqual(['VS Code offers 12 models.']);
  });
});

describe('refresh models', () => {
  it('refreshes and reports failing endpoints', async () => {
    const { ui, registry, commands } = setup(
      [],
      [summary('a', { label: 'A', status: 'error', error: 'Cannot reach it.' }), summary('b')],
    );
    await commands.refreshModels();
    expect(registry.refresh).toHaveBeenCalledTimes(1);
    expect(ui.errors).toEqual(['Listing the models of A failed: Cannot reach it.']);
  });
});
