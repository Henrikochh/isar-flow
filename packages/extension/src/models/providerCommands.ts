import {
  type ModelCatalog,
  ModelError,
  OpenAICompatClient,
  type OpenAICompatConfig,
  type ProviderSummary,
} from '@isar-flow/core';
import type * as vscode from 'vscode';
import type { ModelRegistry } from '../contracts';
import {
  apiKeySecret,
  checkBaseUrl,
  checkProviderId,
  isRecord,
  readProviderConfigs,
  suggestProviderId,
  VSCODE_PROVIDER_ID,
} from './settings';

export interface InputOptions {
  title: string;
  prompt: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  /** Returns the problem with the value, or undefined when it is fine. */
  validate?: (value: string) => string | undefined;
}

/** The dialogs the commands use; implemented with vscode.window in commands.ts. */
export interface CommandUi {
  pick<T extends vscode.QuickPickItem>(
    items: T[],
    options: { title: string; placeHolder?: string },
  ): Promise<T | undefined>;
  input(options: InputOptions): Promise<string | undefined>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
  /** Modal confirmation; true when the user chose `action`. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  /** `quiet` shows progress in the status bar instead of a notification. */
  progress<T>(
    title: string,
    task: (signal: AbortSignal) => Promise<T>,
    options?: { cancellable?: boolean; quiet?: boolean },
  ): Promise<T>;
  openSettings(query: string): void;
}

/** Reads and writes the `isarFlow.providers` entries of the settings scope that defines them. */
export interface ProviderSettingsStore {
  entries(): unknown[];
  save(entries: unknown[]): Promise<void>;
}

export interface ProviderCommandDeps {
  registry: Pick<ModelRegistry, 'refresh' | 'catalog'>;
  secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;
  settings: ProviderSettingsStore;
  ui: CommandUi;
  createClient?: (cfg: OpenAICompatConfig) => Pick<OpenAICompatClient, 'listModels'>;
}

export interface ProviderCommands {
  addProvider(): Promise<void>;
  editProvider(providerId?: string): Promise<void>;
  /**
   * `confirmed`: the caller already asked (the sidebar confirms inline). Honored only together with an id,
   * so an endpoint picked here is always confirmed here.
   */
  removeProvider(providerId?: string, options?: { confirmed?: boolean }): Promise<void>;
  setProviderKey(providerId?: string): Promise<void>;
  testProvider(providerId?: string): Promise<void>;
  refreshModels(): Promise<void>;
}

interface Preset {
  label: string;
  /** Suggested provider id; empty for a custom endpoint. */
  id: string;
  baseUrl: string;
  detail: string;
  askKey: boolean;
}

export const PROVIDER_PRESETS: readonly Preset[] = [
  {
    label: 'LiteLLM',
    id: 'litellm',
    baseUrl: 'http://localhost:4000',
    detail: 'LiteLLM proxy on this computer',
    askKey: true,
  },
  {
    label: 'Ollama',
    id: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    detail: 'Local models with Ollama, no API key needed',
    askKey: false,
  },
  {
    label: 'OpenRouter',
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    detail: 'Many hosted models with one API key',
    askKey: true,
  },
  {
    label: 'OpenAI',
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    detail: 'The OpenAI API',
    askKey: true,
  },
  {
    label: 'Custom…',
    id: '',
    baseUrl: '',
    detail: 'Any OpenAI-compatible endpoint, for example vLLM or LM Studio',
    askKey: true,
  },
];

/** A provider entry as written in the settings, also when other fields of it are invalid. */
interface Entry {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  raw: Record<string, unknown>;
}

type EditAction = 'baseUrl' | 'label' | 'apiKey' | 'models' | 'test' | 'settings' | 'remove';

const EDIT = 'Edit endpoint';
const ADD = 'Add model endpoint';
const SETTING = 'isarFlow.providers';

export function createProviderCommands(deps: ProviderCommandDeps): ProviderCommands {
  const { registry, secrets, settings, ui } = deps;
  const createClient = deps.createClient ?? ((cfg: OpenAICompatConfig) => new OpenAICompatClient(cfg));

  function entries(): Entry[] {
    return settings.entries().flatMap((raw): Entry[] => {
      if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return [];
      const id = raw.id.trim();
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id;
      const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
      const models = Array.isArray(raw.models)
        ? raw.models.filter((m): m is string => typeof m === 'string')
        : [];
      return [{ id, label, baseUrl, models, raw }];
    });
  }

  const isEntry = (raw: unknown, id: string) =>
    isRecord(raw) && typeof raw.id === 'string' && raw.id.trim() === id;

  /** Sets (or, for undefined values, removes) fields of one entry, keeping everything else as written. */
  async function updateEntry(id: string, changes: Record<string, unknown>): Promise<boolean> {
    const all = settings.entries();
    const index = all.findIndex((raw) => isEntry(raw, id));
    const current = all[index];
    if (!isRecord(current)) {
      void ui.error(`The model endpoint '${id}' no longer exists in the setting ${SETTING}.`);
      return false;
    }
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    all[index] = next;
    await settings.save(all);
    return true;
  }

  function summaryOf(catalog: ModelCatalog, id: string): ProviderSummary | undefined {
    return catalog.providers.find((p) => p.id === id);
  }

  /** Refreshes the catalog and tells the user how the endpoint answered. */
  async function report(entry: Pick<Entry, 'id' | 'label'>, success: (n: number) => string, failure: string) {
    const catalog = await ui.progress(`Fetching models from ${entry.label}…`, () => registry.refresh());
    const summary = summaryOf(catalog, entry.id);
    if (!summary) {
      const choice = await ui.error(
        `${failure}: its entry in the setting ${SETTING} is invalid.`,
        'Open settings',
      );
      if (choice) ui.openSettings(SETTING);
      return;
    }
    if (summary.status === 'error') {
      if ((await ui.error(`${failure}: ${summary.error ?? 'unknown error'}`, EDIT)) === EDIT) {
        await commands.editProvider(entry.id);
      }
      return;
    }
    if (summary.modelCount === 0) {
      const message = `${entry.label} lists no models yet. Add model ids under Extra models with '${EDIT}'.`;
      if ((await ui.info(message, EDIT)) === EDIT) await commands.editProvider(entry.id);
      return;
    }
    void ui.info(success(summary.modelCount));
  }

  /** The entry for `providerId`, or the one the user picks when no id was given. */
  async function pickEntry(providerId: string | undefined, title: string): Promise<Entry | undefined> {
    const all = entries();
    if (providerId !== undefined) {
      const found = all.find((e) => e.id === providerId);
      if (!found) void ui.error(`There is no model endpoint '${providerId}' in the setting ${SETTING}.`);
      return found;
    }
    if (!all.length) {
      if ((await ui.info('No model endpoints are set up yet.', ADD)) === ADD) await commands.addProvider();
      return undefined;
    }
    const catalog = registry.catalog();
    const items = all.map((entry) => ({
      label: entry.label,
      description: entry.baseUrl,
      detail: statusText(summaryOf(catalog, entry.id)),
      entry,
    }));
    return (await ui.pick(items, { title, placeHolder: 'Choose a model endpoint' }))?.entry;
  }

  async function explainVsCode(): Promise<void> {
    const message =
      'VS Code models come from extensions such as GitHub Copilot and need no setup in Isar Flow. ' +
      'To hide them, turn off the setting isarFlow.vscodeModels.';
    if (await ui.info(message, 'Open setting')) ui.openSettings('isarFlow.vscodeModels');
  }

  async function editBaseUrl(entry: Entry): Promise<void> {
    const baseUrl = await ui.input({
      title: `Base URL of ${entry.label}`,
      prompt: 'Address of the OpenAI-compatible API. It usually ends with /v1.',
      value: entry.baseUrl,
      validate: checkBaseUrl,
    });
    if (baseUrl === undefined || !(await updateEntry(entry.id, { baseUrl: baseUrl.trim() }))) return;
    await report(
      entry,
      (n) => `Updated ${entry.label}: ${available(n)}.`,
      `Updated ${entry.label}, but its models could not be listed`,
    );
  }

  async function editLabel(entry: Entry): Promise<void> {
    const label = await ui.input({
      title: `Name of ${entry.id}`,
      prompt: 'Name shown in model pickers. Leave empty to show the id.',
      value: entry.label === entry.id ? '' : entry.label,
    });
    if (label === undefined) return;
    await updateEntry(entry.id, { label: label.trim() || undefined });
  }

  async function editModels(entry: Entry): Promise<void> {
    const text = await ui.input({
      title: `Extra models of ${entry.label}`,
      prompt:
        'Model ids offered in addition to the ones the server lists, separated by commas. Leave empty for none.',
      value: entry.models.join(', '),
      placeHolder: 'for example gpt-4.1, llama3:8b',
    });
    if (text === undefined) return;
    const models = text
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (!(await updateEntry(entry.id, { models: models.length ? models : undefined }))) return;
    await report(
      entry,
      (n) => `Updated ${entry.label}: ${available(n)}.`,
      `Updated ${entry.label}, but its models could not be listed`,
    );
  }

  const commands: ProviderCommands = {
    async addProvider() {
      const presets = PROVIDER_PRESETS.map((preset) => ({
        label: preset.label,
        description: preset.baseUrl || undefined,
        detail: preset.detail,
        preset,
      }));
      const picked = await ui.pick(presets, { title: ADD, placeHolder: 'Which server do you want to use?' });
      if (!picked) return;
      const { preset } = picked;
      const existing = entries();
      const taken = existing.map((e) => e.id);
      const steps = preset.askKey ? 3 : 2;

      const idText = await ui.input({
        title: `${ADD} (1/${steps})`,
        prompt: 'Short id used in model references, for example litellm → litellm/gpt-4.1',
        value: preset.id ? suggestProviderId(preset.id, taken) : '',
        placeHolder: 'for example vllm',
        validate: (value) => checkProviderId(value, taken),
      });
      if (idText === undefined) return;
      const id = idText.trim();

      const baseUrlText = await ui.input({
        title: `${ADD} (2/${steps})`,
        prompt: 'Base URL of the OpenAI-compatible API',
        value: preset.baseUrl,
        placeHolder: 'for example http://localhost:8000/v1',
        validate: checkBaseUrl,
      });
      if (baseUrlText === undefined) return;
      const baseUrl = baseUrlText.trim();

      const custom = !preset.id;
      const label = custom
        ? id
        : existing.some((e) => e.label === preset.label)
          ? `${preset.label} (${id})`
          : preset.label;

      let apiKey = '';
      if (preset.askKey) {
        const key = await ui.input({
          title: `${ADD} (3/${steps})`,
          prompt: `API key for ${label}. Leave empty if the endpoint needs none. It is kept in VS Code's secret storage, not in settings.`,
          password: true,
        });
        if (key === undefined) return;
        apiKey = key.trim();
      }

      const secret = apiKeySecret(id);
      // Store the key first so the refresh triggered by the settings change already uses it.
      if (apiKey) await secrets.store(secret, apiKey);
      else if (await secrets.get(secret)) await secrets.delete(secret);
      const entry: Record<string, unknown> = custom ? { id, baseUrl } : { id, label, baseUrl };
      await settings.save([...settings.entries(), entry]);
      await report(
        { id, label },
        (n) => `Added ${label} with ${count(n)}.`,
        `Added ${label}, but its models could not be listed`,
      );
    },

    async editProvider(providerId) {
      if (providerId === VSCODE_PROVIDER_ID) return explainVsCode();
      const entry = await pickEntry(providerId, 'Edit model endpoint');
      if (!entry) return;
      const summary = summaryOf(registry.catalog(), entry.id);
      const hasKey = Boolean(await secrets.get(apiKeySecret(entry.id)));
      const items: (vscode.QuickPickItem & { action: EditAction })[] = [
        { label: '$(link) Base URL', description: entry.baseUrl || 'Not set', action: 'baseUrl' },
        { label: '$(tag) Name', description: entry.label, action: 'label' },
        { label: '$(key) API key', description: hasKey ? 'Stored' : 'Not set', action: 'apiKey' },
        {
          label: '$(list-unordered) Extra models',
          description: entry.models.join(', ') || 'None',
          detail: 'Model ids offered in addition to the ones the server lists',
          action: 'models',
        },
        { label: '$(beaker) Test endpoint', action: 'test' },
        { label: '$(settings-gear) Open settings', action: 'settings' },
        { label: '$(trash) Remove endpoint', action: 'remove' },
      ];
      const placeHolder =
        summary?.status === 'error' && summary.error ? summary.error : `What do you want to change?`;
      const choice = await ui.pick(items, { title: `Edit model endpoint: ${entry.label}`, placeHolder });
      switch (choice?.action) {
        case 'baseUrl':
          return editBaseUrl(entry);
        case 'label':
          return editLabel(entry);
        case 'apiKey':
          return commands.setProviderKey(entry.id);
        case 'models':
          return editModels(entry);
        case 'test':
          return commands.testProvider(entry.id);
        case 'settings':
          return ui.openSettings(SETTING);
        case 'remove':
          return commands.removeProvider(entry.id);
      }
    },

    async removeProvider(providerId, options = {}) {
      if (providerId === VSCODE_PROVIDER_ID) return explainVsCode();
      const entry = await pickEntry(providerId, 'Remove model endpoint');
      if (!entry) return;
      const confirmed =
        (options.confirmed === true && providerId !== undefined) ||
        (await ui.confirm(
          `Remove the model endpoint '${entry.label}'?`,
          "Agents that use its models stop working until you add it again. Its API key is deleted from VS Code's secret storage.",
          'Remove',
        ));
      if (!confirmed) return;
      await settings.save(settings.entries().filter((raw) => !isEntry(raw, entry.id)));
      await secrets.delete(apiKeySecret(entry.id));
    },

    async setProviderKey(providerId) {
      if (providerId === VSCODE_PROVIDER_ID) {
        void ui.info(
          'VS Code models need no API key in Isar Flow; they use the account of the extension that provides them, ' +
            'for example GitHub Copilot.',
        );
        return;
      }
      const entry = await pickEntry(providerId, 'Set provider API key');
      if (!entry) return;
      const secret = apiKeySecret(entry.id);
      const hasKey = Boolean(await secrets.get(secret));
      const value = await ui.input({
        title: `API key for ${entry.label}`,
        prompt: hasKey
          ? 'Enter a new API key, or leave empty to remove the stored one.'
          : "Enter the API key. It is kept in VS Code's secret storage, not in settings.",
        placeHolder: hasKey ? 'A key is stored' : undefined,
        password: true,
      });
      if (value === undefined) return;
      const key = value.trim();
      if (!key) {
        if (!hasKey) return;
        await secrets.delete(secret);
        void ui.info(`Removed the API key of ${entry.label}.`);
        return;
      }
      await secrets.store(secret, key);
      await report(
        entry,
        (n) => `Saved the API key of ${entry.label}. ${capitalize(available(n))}.`,
        `Saved the API key of ${entry.label}, but its models could not be listed`,
      );
    },

    async testProvider(providerId) {
      if (providerId === VSCODE_PROVIDER_ID) return testVsCode();
      const entry = await pickEntry(providerId, 'Test model endpoint');
      if (!entry) return;
      const problem = checkBaseUrl(entry.baseUrl);
      if (problem) {
        const message = `${entry.label} has no valid base URL. Set it with '${EDIT}': ${problem}`;
        if ((await ui.error(message, EDIT)) === EDIT) await commands.editProvider(entry.id);
        return;
      }
      const apiKey = (await secrets.get(apiKeySecret(entry.id)))?.trim() || undefined;
      const headers = readProviderConfigs([entry.raw]).configs[0]?.headers;
      // Without the manual model list, the client cannot fall back to it, so auth and URL errors surface.
      const client = createClient({
        id: entry.id,
        label: entry.label,
        baseUrl: entry.baseUrl,
        apiKey,
        headers,
        discoverModels: true,
        retry: { attempts: 1 },
      });
      try {
        const models = await ui.progress(`Testing ${entry.label}…`, (signal) => client.listModels(signal), {
          cancellable: true,
        });
        if (!models.length) {
          void ui.info(
            `${entry.label} answered, but lists no models. Add model ids under Extra models with '${EDIT}'.`,
          );
          return;
        }
        const names = models.slice(0, 5).map((m) => m.name);
        const more = models.length > names.length ? ', …' : '';
        void ui.info(`${entry.label} works: ${available(models.length)} (${names.join(', ')}${more}).`);
      } catch (error) {
        if (error instanceof ModelError && error.kind === 'aborted') return;
        const message = `Testing ${entry.label} failed: ${error instanceof Error ? error.message : String(error)}`;
        if ((await ui.error(message, EDIT)) === EDIT) await commands.editProvider(entry.id);
      }
    },

    async refreshModels() {
      const catalog = await ui.progress('Refreshing models…', () => registry.refresh(), { quiet: true });
      const failed = catalog.providers.filter((p) => p.status === 'error');
      if (!failed.length) return;
      const message = failed
        .map((p) => `Listing the models of ${p.label} failed: ${p.error ?? 'unknown error'}`)
        .join(' ');
      const editable = failed.length === 1 && failed[0].kind !== 'vscode' ? [EDIT] : [];
      if ((await ui.error(message, ...editable)) === EDIT) await commands.editProvider(failed[0].id);
    },
  };

  async function testVsCode(): Promise<void> {
    const catalog = await ui.progress('Fetching VS Code models…', () => registry.refresh());
    const summary = summaryOf(catalog, VSCODE_PROVIDER_ID);
    if (!summary) {
      const message = 'VS Code models are turned off. Turn on the setting isarFlow.vscodeModels to use them.';
      if (await ui.info(message, 'Open setting')) ui.openSettings('isarFlow.vscodeModels');
    } else if (summary.status === 'error') {
      void ui.error(`Listing the VS Code models failed: ${summary.error ?? 'unknown error'}`);
    } else {
      void ui.info(`VS Code offers ${count(summary.modelCount)}.`);
    }
  }

  return commands;
}

function statusText(summary: ProviderSummary | undefined): string {
  if (!summary) return 'Not loaded: check its settings';
  switch (summary.status) {
    case 'loading':
      return 'Loading models…';
    case 'error':
      return summary.error ?? 'Listing the models failed';
    default: {
      const key = summary.hasApiKey ? ' · API key stored' : '';
      return `${count(summary.modelCount)}${key}`;
    }
  }
}

function count(n: number): string {
  return `${n} model${n === 1 ? '' : 's'}`;
}

function available(n: number): string {
  return `${count(n)} ${n === 1 ? 'is' : 'are'} available`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
