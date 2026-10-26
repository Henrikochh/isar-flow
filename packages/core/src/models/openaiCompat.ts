import {
  cancelledError,
  clip,
  connectionLostError,
  httpError,
  invalidBaseUrlError,
  invalidHeaderError,
  unreachableError,
} from './errors';
import {
  buildChatBody,
  type CompatFeature,
  parseModelList,
  rejectedFeature,
  StreamAssembler,
  streamErrorMessage,
} from './openaiWire';
import { type RetryOptions, withRetry } from './retry';
import { parseSSE } from './sse';
import {
  type ChatMessage,
  type ChatModel,
  type ChatModelInfo,
  type ChatOptions,
  type ChatStreamEvent,
  ModelError,
} from './types';

export interface OpenAICompatConfig {
  /** Provider id, the first part of model refs (`<id>/<model>`). */
  id: string;
  /** Human label used in the UI and in error messages. */
  label: string;
  /** API root, e.g. `http://localhost:4000/v1`. Without `/v1`, the client tries `<base>/v1` when `<base>` answers 404. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Models to offer in addition to (or, without discovery, instead of) the discovered ones. */
  models?: string[];
  /** Ask the server for its models via `GET /models` (default true). */
  discoverModels?: boolean;
  fetch?: typeof fetch;
  retry?: { attempts?: number; baseDelayMs?: number };
}

type OpenedChat = { kind: 'stream'; body: ReadableStream<Uint8Array> } | { kind: 'json'; payload: unknown };

const V1_SUFFIX = /\/v1$/i;

/** Client for OpenAI-compatible chat APIs (LiteLLM, Ollama, vLLM, OpenRouter ...). Uses only `fetch`. */
export class OpenAICompatClient {
  readonly id: string;
  readonly label: string;
  private readonly baseUrl: string;
  /** Root used for requests: the base URL, or `<base>/v1` once that turned out to be the working one. */
  private apiBase: string;
  private apiBaseConfirmed = false;
  private readonly fetchImpl: typeof fetch;
  /** Optional request fields each model's server rejected, so later calls leave them out. */
  private readonly unsupported = new Map<string, Set<CompatFeature>>();

  constructor(private readonly config: OpenAICompatConfig) {
    this.id = config.id;
    this.label = config.label;
    this.baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
    this.apiBase = this.baseUrl;
    // Resolve the global lazily so it is called with the right `this` and can be replaced in tests.
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Discovered models merged with the manual list, sorted by name. */
  async listModels(signal?: AbortSignal): Promise<ChatModelInfo[]> {
    const manual = this.config.models ?? [];
    if (this.config.discoverModels === false) return this.toInfos(manual);
    let discovered: string[];
    try {
      discovered = await withRetry(() => this.fetchModelIds(signal), this.retryOptions(signal));
    } catch (error) {
      const failure = this.toModelError(error, signal, 'connect');
      if (failure.kind !== 'aborted' && manual.some((id) => id.trim())) return this.toInfos(manual);
      throw failure;
    }
    return this.toInfos([...discovered, ...manual]);
  }

  model(modelId: string): ChatModel {
    return { ...this.info(modelId), chat: (messages, options) => this.chat(modelId, messages, options) };
  }

  private info(modelId: string): ChatModelInfo {
    return {
      ref: `${this.id}/${modelId}`,
      provider: this.id,
      providerLabel: this.label,
      id: modelId,
      name: modelId,
      capabilities: { tools: true, jsonSchema: true },
    };
  }

  private toInfos(ids: string[]): ChatModelInfo[] {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    return unique
      .map((id) => this.info(id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  private retryOptions(signal: AbortSignal | undefined): RetryOptions {
    return { attempts: this.config.retry?.attempts, baseDelayMs: this.config.retry?.baseDelayMs, signal };
  }

  private async fetchModelIds(signal: AbortSignal | undefined): Promise<string[]> {
    const response = await this.request('/models', { method: 'GET', headers: this.headers() }, signal);
    const url = response.url || `${this.apiBase}/models`;
    const text = await this.readText(response, signal);
    if (!response.ok) {
      throw httpError(response.status, text, { label: this.label, url }, response.headers.get('retry-after'));
    }
    const ids = parseModelList(parseJson(text));
    if (!ids) {
      throw new ModelError(
        `The provider '${this.label}' returned an unexpected model list from ${url}. ` +
          'Check that the base URL points to an OpenAI-compatible API (it usually ends with /v1).',
        'other',
      );
    }
    return ids;
  }

  private async *chat(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<ChatStreamEvent, void, undefined> {
    const { signal } = options;
    if (signal?.aborted) throw cancelledError(this.label);
    let opened: OpenedChat;
    try {
      // Only opening the stream is retried: once text has been handed out, a retry would duplicate it.
      opened = await withRetry(() => this.openChat(modelId, messages, options), this.retryOptions(signal));
    } catch (error) {
      throw this.toModelError(error, signal, 'connect');
    }

    const assembler = new StreamAssembler();
    if (opened.kind === 'json') {
      const text = assembler.push(opened.payload);
      if (text) yield { type: 'text', text };
      yield* this.closingEvents(assembler, signal);
      return;
    }
    let received = 0;
    try {
      for await (const data of parseSSE(opened.body, signal)) {
        received++;
        if (data === '[DONE]') break;
        if (!data.trim()) continue;
        const text = assembler.push(this.parseChunk(data));
        if (text) yield { type: 'text', text };
      }
    } catch (error) {
      throw this.toModelError(error, signal, 'stream');
    }
    // A web page or other non-SSE body has no events; finishing normally would look like an empty answer.
    if (received === 0) {
      throw new ModelError(
        `The provider '${this.label}' answered ${this.apiBase}/chat/completions without any streamed data. ` +
          'Check that the base URL points to an OpenAI-compatible API (it usually ends with /v1).',
        'other',
      );
    }
    yield* this.closingEvents(assembler, signal);
  }

  /** Tool calls, usage and `done`, stopping as soon as the caller aborts. */
  private *closingEvents(assembler: StreamAssembler, signal: AbortSignal | undefined) {
    for (const event of assembler.finish()) {
      if (signal?.aborted) throw cancelledError(this.label);
      yield event;
    }
  }

  /** One attempt: sends the request (dropping fields the server rejects) and waits for the first byte. */
  private async openChat(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<OpenedChat> {
    const { signal } = options;
    let unsupported = this.unsupported.get(modelId);
    if (!unsupported) {
      unsupported = new Set();
      this.unsupported.set(modelId, unsupported);
    }
    for (;;) {
      const body = buildChatBody(modelId, messages, options, unsupported);
      const init: RequestInit = {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
        body: JSON.stringify(body),
      };
      const response = await this.request('/chat/completions', init, signal);
      if (!response.ok) {
        const text = await this.readText(response, signal);
        // Each feature can be dropped only once, so this loop ends after at most three requests.
        const feature = rejectedFeature(response.status, text, body);
        if (feature) {
          unsupported.add(feature);
          continue;
        }
        const ctx = { label: this.label, url: response.url || `${this.apiBase}/chat/completions`, modelId };
        throw httpError(response.status, text, ctx, response.headers.get('retry-after'));
      }
      // Some servers ignore `stream: true` and answer with one complete JSON completion.
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        return { kind: 'json', payload: this.parseChunk(await this.readText(response, signal)) };
      }
      return { kind: 'stream', body: await this.firstByte(response, signal) };
    }
  }

  /** Waits for the first body chunk so that a connection dropped before any data is still retried. */
  private async firstByte(
    response: Response,
    signal: AbortSignal | undefined,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!response.body) throw new ModelError(`The provider '${this.label}' sent an empty answer.`, 'server');
    const reader = response.body.getReader();
    const first = await reader.read().catch((error: unknown) => {
      throw this.toModelError(error, signal, 'stream');
    });
    if (first.done) throw new ModelError(`The provider '${this.label}' sent an empty answer.`, 'server');
    const head = first.value;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  private parseChunk(data: string): unknown {
    const chunk = parseJson(data);
    if (chunk === undefined) throw this.malformed(data);
    const streamError = streamErrorMessage(chunk);
    if (streamError !== undefined) {
      throw new ModelError(
        `The provider '${this.label}' reported an error while answering: ${clip(streamError)}`,
        'server',
      );
    }
    return chunk;
  }

  private malformed(data: string): ModelError {
    return new ModelError(
      `The provider '${this.label}' sent a malformed response: ${clip(data, 200)}. Check that it is an OpenAI-compatible API.`,
      'other',
    );
  }

  /**
   * Sends a request below the API root. When the base URL lacks `/v1` and answers 404, retries below
   * `<base>/v1` and keeps using that root if it exists.
   */
  private async request(path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    const response = await this.send(`${this.apiBase}${path}`, init, signal);
    if (response.status !== 404 || this.apiBaseConfirmed || V1_SUFFIX.test(this.apiBase)) {
      if (response.ok) this.apiBaseConfirmed = true;
      return response;
    }
    const v1Base = `${this.apiBase}/v1`;
    const retry = await this.send(`${v1Base}${path}`, init, signal);
    if (retry.status === 404) {
      await retry.body?.cancel().catch(() => undefined);
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    this.apiBase = v1Base;
    return retry;
  }

  private async send(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    // fetch rejects bad URLs and headers with the same TypeError as a dead server, so check them first.
    this.checkSettings();
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      throw this.toModelError(error, signal, 'connect');
    }
  }

  private async readText(response: Response, signal: AbortSignal | undefined): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw this.toModelError(error, signal, 'stream');
    }
  }

  /** Throws a ModelError for settings that make every request fail: a malformed base URL or header. */
  private checkSettings(): void {
    if (!isHttpUrl(this.baseUrl)) throw invalidBaseUrlError(this.label, this.config.baseUrl);
    for (const [name, value] of Object.entries(this.headers())) {
      if (isSendableHeader(name, value)) continue;
      const isApiKey = Boolean(this.config.apiKey) && name === 'Authorization';
      throw invalidHeaderError(this.label, name, isApiKey);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extra, ...this.config.headers };
    if (this.config.apiKey) {
      for (const name of Object.keys(headers))
        if (name.toLowerCase() === 'authorization') delete headers[name];
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private toModelError(
    error: unknown,
    signal: AbortSignal | undefined,
    phase: 'connect' | 'stream',
  ): ModelError {
    if (signal?.aborted) return cancelledError(this.label);
    if (error instanceof ModelError) return error;
    return phase === 'connect'
      ? unreachableError(this.baseUrl, error)
      : connectionLostError(this.baseUrl, error);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isSendableHeader(name: string, value: string): boolean {
  try {
    return new Headers([[name, value]]).has(name);
  } catch {
    return false;
  }
}
