import {
  type ChatModel,
  type ChatModelInfo,
  type ModelCatalog,
  ModelError,
  OpenAICompatClient,
  type OpenAICompatConfig,
  parseModelRef,
  type ProviderSummary,
} from '@isar-flow/core';
import * as vscode from 'vscode';
import type { ModelRegistry, ProviderConfig } from '../contracts';
import { apiKeySecret, providerIdFromSecret, readProviderConfigs, VSCODE_PROVIDER_ID } from './settings';
import {
  compareModelNames,
  listVsCodeModels,
  mapLanguageModelError,
  VSCODE_PROVIDER_LABEL,
  wrapVsCodeModel,
} from './vscodeLm';

export interface ModelSettings {
  /** Raw value of `isarFlow.providers`. */
  providers: unknown;
  vscodeModels: boolean;
}

export type CompatClient = Pick<OpenAICompatClient, 'listModels' | 'model'>;

export interface ModelRegistryDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  getConfig?: () => ModelSettings;
  lm?: Pick<typeof vscode.lm, 'selectChatModels' | 'onDidChangeChatModels'>;
  createClient?: (cfg: OpenAICompatConfig) => CompatClient;
}

/** VS Code announces model changes in bursts (e.g. while Copilot starts); listing waits until they settle. */
const LM_CHANGE_DELAY_MS = 300;

type Status = ProviderSummary['status'];

interface Listing {
  status: Status;
  error?: string;
  models: ChatModelInfo[];
}

interface EndpointState extends Listing {
  config: ProviderConfig;
  client?: CompatClient;
  hasApiKey: boolean;
}

export function createModelRegistry(deps: ModelRegistryDeps): ModelRegistry {
  return new Registry(deps);
}

/**
 * Reads the model settings. In an untrusted workspace only the user's endpoints count: an endpoint the
 * workspace defines with the id of one of the user's endpoints would otherwise receive its stored API key.
 */
export function readModelSettings(
  config: Pick<vscode.WorkspaceConfiguration, 'get' | 'inspect'> = vscode.workspace.getConfiguration('isarFlow'),
  trusted: boolean = vscode.workspace.isTrusted,
): ModelSettings {
  let providers: unknown;
  if (trusted) {
    providers = config.get<unknown>('providers', []);
  } else {
    const inspected = config.inspect<unknown>('providers');
    providers = inspected?.globalValue ?? inspected?.defaultValue ?? [];
  }
  return { providers, vscodeModels: config.get<boolean>('vscodeModels', true) !== false };
}

class Registry implements ModelRegistry {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private readonly getConfig: () => ModelSettings;
  private readonly lm: NonNullable<ModelRegistryDeps['lm']>;
  private readonly createClient: (cfg: OpenAICompatConfig) => CompatClient;
  private readonly disposables: vscode.Disposable[] = [];

  private started = false;
  private disposed = false;
  private generation = 0;
  private abort: AbortController | undefined;
  /** Settles when the clients of the latest refresh exist. */
  private ready: Promise<void> = Promise.resolve();
  private latest: Promise<ModelCatalog> | undefined;
  private endpoints: EndpointState[] = [];
  private vscodeEnabled = false;
  private vscodeModels: Listing = { status: 'unknown', models: [] };
  private vscodeListing = 0;
  private lmTimer: ReturnType<typeof setTimeout> | undefined;
  private lastProblems = new Set<string>();

  constructor(private readonly deps: ModelRegistryDeps) {
    this.getConfig = deps.getConfig ?? readModelSettings;
    this.lm = deps.lm ?? vscode.lm;
    this.createClient = deps.createClient ?? ((cfg) => new OpenAICompatClient(cfg));
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('isarFlow.providers') ||
          event.affectsConfiguration('isarFlow.vscodeModels')
        ) {
          this.refreshIfStarted();
        }
      }),
      deps.context.secrets.onDidChange((event) => {
        if (providerIdFromSecret(event.key) !== undefined) this.refreshIfStarted();
      }),
      // Endpoints from the workspace settings count only in a trusted workspace.
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshIfStarted()),
      this.lm.onDidChangeChatModels(() => this.scheduleVsCodeListing()),
    );
  }

  catalog(): ModelCatalog {
    this.ensureStarted();
    return this.snapshot();
  }

  refresh(): Promise<ModelCatalog> {
    const run = this.runRefresh();
    this.latest = run;
    return run;
  }

  async resolve(ref: string): Promise<ChatModel> {
    this.ensureStarted();
    const { provider, model } = parseModelRef(ref);
    if (provider === VSCODE_PROVIDER_ID) return this.resolveVsCode(ref, model);

    // Wait for the clients of the newest settings, also when they change meanwhile.
    for (let ready = this.ready; ; ready = this.ready) {
      await ready;
      if (ready === this.ready) break;
    }
    const endpoint = this.endpoints.find((e) => e.config.id === provider);
    if (!endpoint) {
      throw new ModelError(
        `Unknown model provider '${provider}' in '${ref}'. Add it with 'Isar Flow: Add model endpoint'.`,
        'not-found',
      );
    }
    if (!endpoint.client) {
      throw new ModelError(
        endpoint.error ?? `The model provider '${endpoint.config.label}' could not be set up.`,
        'other',
      );
    }
    return endpoint.client.model(model);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort?.abort();
    clearTimeout(this.lmTimer);
    for (const d of this.disposables.splice(0)) d.dispose();
    this.emitter.dispose();
  }

  /* ---------- loading ---------- */

  private ensureStarted(): void {
    if (!this.started && !this.disposed) this.startRefresh();
  }

  private refreshIfStarted(): void {
    if (this.started && !this.disposed) this.startRefresh();
  }

  private startRefresh(): void {
    this.refresh().catch((error: unknown) =>
      this.deps.log.error(`Refreshing models failed: ${messageOf(error)}`),
    );
  }

  private async runRefresh(): Promise<ModelCatalog> {
    this.started = true;
    const generation = ++this.generation;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;

    const settings = this.readSettings();
    const { configs, problems } = readProviderConfigs(settings.providers);
    this.reportProblems(problems);

    // Keep the previous models while loading so model pickers do not flicker.
    const previous = new Map(this.endpoints.map((e) => [e.config.id, e]));
    const endpoints: EndpointState[] = configs.map((config) => ({
      config,
      hasApiKey: previous.get(config.id)?.hasApiKey ?? false,
      status: 'loading',
      models: previous.get(config.id)?.models ?? [],
    }));
    this.endpoints = endpoints;
    this.vscodeEnabled = settings.vscodeModels;
    this.vscodeModels = settings.vscodeModels
      ? { status: 'loading', models: this.vscodeModels.models }
      : { status: 'unknown', models: [] };
    this.fire();

    const ready = this.createClients(endpoints);
    this.ready = ready;
    await ready;
    if (generation !== this.generation) return this.settled();

    const isCurrent = () => generation === this.generation && !this.disposed;
    await Promise.all([
      settings.vscodeModels ? this.listVsCode() : undefined,
      ...endpoints.map((endpoint) => this.listEndpoint(endpoint, abort.signal, isCurrent)),
    ]);
    return generation === this.generation ? this.snapshot() : this.settled();
  }

  /** The result of the newest refresh, for callers of a refresh that was superseded. */
  private settled(): Promise<ModelCatalog> {
    return this.disposed || !this.latest ? Promise.resolve(this.snapshot()) : this.latest;
  }

  private readSettings(): ModelSettings {
    try {
      return this.getConfig();
    } catch (error) {
      this.deps.log.error(`Reading the Isar Flow model settings failed: ${messageOf(error)}`);
      return { providers: [], vscodeModels: true };
    }
  }

  private async createClients(endpoints: EndpointState[]): Promise<void> {
    await Promise.all(
      endpoints.map(async (endpoint) => {
        const { config } = endpoint;
        const apiKey = await this.readApiKey(config.id);
        endpoint.hasApiKey = apiKey !== undefined;
        try {
          endpoint.client = this.createClient({
            id: config.id,
            label: config.label ?? config.id,
            baseUrl: config.baseUrl,
            apiKey,
            headers: config.headers,
            models: config.models,
            discoverModels: config.discoverModels,
          });
        } catch (error) {
          endpoint.status = 'error';
          endpoint.error = messageOf(error);
          endpoint.models = [];
        }
      }),
    );
  }

  private async readApiKey(providerId: string): Promise<string | undefined> {
    try {
      const key = await this.deps.context.secrets.get(apiKeySecret(providerId));
      return key?.trim() || undefined;
    } catch (error) {
      this.deps.log.warn(
        `Reading the API key of '${providerId}' from the secret storage failed: ${messageOf(error)}`,
      );
      return undefined;
    }
  }

  private async listEndpoint(
    endpoint: EndpointState,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<void> {
    const { client, config } = endpoint;
    if (!client) return;
    const label = config.label ?? config.id;
    try {
      const models = await client.listModels(signal);
      if (!isCurrent()) return;
      endpoint.models = [...models].sort(compareModelNames);
      endpoint.status = 'ok';
      endpoint.error = undefined;
      this.deps.log.info(`Found ${count(models.length)} at '${label}'.`);
    } catch (error) {
      if (!isCurrent()) return;
      endpoint.models = [];
      endpoint.status = 'error';
      endpoint.error = messageOf(error);
      this.deps.log.warn(`Listing the models of '${label}' failed: ${endpoint.error}`);
    }
    this.fire();
  }

  private async listVsCode(): Promise<void> {
    const listing = ++this.vscodeListing;
    const isCurrent = () => listing === this.vscodeListing && this.vscodeEnabled && !this.disposed;
    try {
      const models = await listVsCodeModels(this.lm);
      if (!isCurrent()) return;
      this.vscodeModels = { status: 'ok', models };
      this.deps.log.info(`VS Code offers ${count(models.length)}.`);
    } catch (error) {
      if (!isCurrent()) return;
      this.vscodeModels = { status: 'error', error: messageOf(error), models: [] };
      this.deps.log.warn(`Listing the VS Code language models failed: ${messageOf(error)}`);
    }
    this.fire();
  }

  private scheduleVsCodeListing(): void {
    clearTimeout(this.lmTimer);
    this.lmTimer = setTimeout(() => {
      this.lmTimer = undefined;
      if (this.started && this.vscodeEnabled && !this.disposed) void this.listVsCode();
    }, LM_CHANGE_DELAY_MS);
  }

  private async resolveVsCode(ref: string, rest: string): Promise<ChatModel> {
    if (!this.vscodeEnabled) {
      throw new ModelError(
        `VS Code language models are turned off, so '${ref}' cannot be used. ` +
          'Turn on the setting isarFlow.vscodeModels or pick another model.',
        'not-found',
      );
    }
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) {
      throw new Error(
        `Invalid VS Code model reference '${ref}'. Use "vscode/<vendor>/<model>", e.g. "vscode/copilot/gpt-4.1".`,
      );
    }
    const vendor = rest.slice(0, slash);
    const id = rest.slice(slash + 1);
    try {
      let found: vscode.LanguageModelChat | undefined = (await this.lm.selectChatModels({ vendor, id }))[0];
      if (!found) {
        // Models can register late, and some references name the model family; look through the vendor once more.
        const all = await this.lm.selectChatModels({ vendor });
        found = all.find((m) => m.id === id) ?? all.find((m) => m.family === id);
      }
      if (found) return wrapVsCodeModel(found);
    } catch (error) {
      throw mapLanguageModelError(error, { name: id, id });
    }
    throw new ModelError(
      `VS Code has no language model '${id}' from '${vendor}'. Check that the extension that provides it ` +
        '(for example GitHub Copilot) is installed and signed in, or pick another model.',
      'not-found',
    );
  }

  /* ---------- state ---------- */

  private snapshot(): ModelCatalog {
    const providers: ProviderSummary[] = [];
    const models: ChatModelInfo[] = [];
    if (this.vscodeEnabled) {
      const { status, error, models: vscodeModels } = this.vscodeModels;
      providers.push({
        id: VSCODE_PROVIDER_ID,
        label: VSCODE_PROVIDER_LABEL,
        kind: 'vscode',
        hasApiKey: false,
        status,
        ...(error ? { error } : {}),
        modelCount: vscodeModels.length,
      });
      models.push(...vscodeModels);
    }
    for (const endpoint of this.endpoints) {
      const { config, status, error } = endpoint;
      providers.push({
        id: config.id,
        label: config.label ?? config.id,
        kind: 'openai-compatible',
        baseUrl: config.baseUrl,
        hasApiKey: endpoint.hasApiKey,
        status,
        ...(error ? { error } : {}),
        modelCount: endpoint.models.length,
      });
      models.push(...endpoint.models);
    }
    return { models, providers, loading: !this.started || providers.some((p) => p.status === 'loading') };
  }

  private fire(): void {
    if (!this.disposed) this.emitter.fire();
  }

  /** Logs settings problems and shows the ones that were not there at the previous refresh. */
  private reportProblems(problems: string[]): void {
    const fresh = problems.filter((p) => !this.lastProblems.has(p));
    this.lastProblems = new Set(problems);
    if (!fresh.length) return;
    for (const problem of fresh) this.deps.log.warn(problem);
    const more = fresh.length - 1;
    const message = more
      ? `${fresh[0]} The Isar Flow log lists ${more} more problem${more === 1 ? '' : 's'} with model endpoints.`
      : fresh[0];
    void Promise.resolve(vscode.window.showWarningMessage(message, 'Open settings')).then((choice) => {
      if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'isarFlow.providers');
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function count(n: number): string {
  return `${n} model${n === 1 ? '' : 's'}`;
}
