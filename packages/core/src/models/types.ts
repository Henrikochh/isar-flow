export interface ModelCapabilities {
  /** Supports tool / function calling. */
  tools: boolean;
  /** Supports a JSON-schema constrained response format. */
  jsonSchema: boolean;
}

export interface ChatModelInfo {
  /** Full reference used in YAML: `<provider>/<model id>`, e.g. `litellm/gpt-4.1`, `vscode/copilot/gpt-4.1`. */
  ref: string;
  /** Provider id, e.g. `litellm` or `vscode`. */
  provider: string;
  /** Human label of the provider, e.g. "LiteLLM (localhost:4000)" or "VS Code". */
  providerLabel: string;
  /** Model id within the provider (may contain `/`). */
  id: string;
  /** Display name. */
  name: string;
  family?: string;
  capabilities: ModelCapabilities;
  maxInputTokens?: number;
}

/**
 * Result of "Test model": one tool call and one JSON answer. `tools`: native tool calls work. `text`: the model
 * answered without a native tool call, so agents should use toolMode text. `failed`: the model could not be used.
 */
export type ModelProbeOutcome = 'tools' | 'text' | 'failed';

export interface ModelProbeResult {
  /** Model reference `<provider>/<model id>`. */
  ref: string;
  outcome: ModelProbeOutcome;
  /** One sentence for people: "Tool calls work", "Needs text tool mode", or what failed and how to fix it. */
  message: string;
  /** The model made the probe's tool call natively. */
  toolCalls: boolean;
  /** The model's JSON answer could be parsed. */
  json: boolean;
  /** Duration of the whole probe. */
  latencyMs?: number;
  /** Epoch milliseconds. */
  testedAt: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text of the arguments as produced by the model. */
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatOptions {
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON answer matching this schema (providers without support ignore it). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: 'stop' | 'tool-calls' | 'length' | 'other' };

export interface ChatModel extends ChatModelInfo {
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamEvent>;
}

/** Resolves `<provider>/<model>` references to callable models (implemented by the extension's registry). */
export interface ModelResolver {
  resolve(ref: string): Promise<ChatModel>;
}

export type ModelErrorKind =
  'auth' | 'not-found' | 'rate-limit' | 'server' | 'network' | 'bad-request' | 'aborted' | 'other';

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: ModelErrorKind,
    readonly status?: number,
    /** How long the server asked to wait before retrying (from Retry-After); used by withRetry. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }

  get retryable(): boolean {
    return this.kind === 'rate-limit' || this.kind === 'server' || this.kind === 'network';
  }
}

/** Splits `<provider>/<model>` at the first `/`. Throws for refs without a provider part. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid model reference '${ref}'. Use "<provider>/<model>", e.g. "litellm/gpt-4.1".`);
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
