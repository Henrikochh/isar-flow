import { isRecord, messageFromPayload } from './errors';
import type { ChatMessage, ChatOptions, ChatStreamEvent, ToolSpec } from './types';

/** Optional request fields that some OpenAI-compatible servers reject. */
export type CompatFeature = 'stream_options' | 'response_format';

const COMPAT_FEATURES: readonly CompatFeature[] = ['stream_options', 'response_format'];

export function toWireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
      case 'user':
        return { role: message.role, content: message.content };
      case 'assistant':
        if (!message.toolCalls?.length) return { role: 'assistant', content: message.content };
        return {
          role: 'assistant',
          // OpenAI expects null rather than '' for a turn that only calls tools.
          content: message.content === '' ? null : message.content,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
  });
}

export function toWireTools(tools: ToolSpec[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** OpenAI only accepts `[a-zA-Z0-9_-]{1,64}` as a response format name. */
function schemaName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'response';
}

export function buildChatBody(
  modelId: string,
  messages: ChatMessage[],
  options: ChatOptions,
  unsupported: ReadonlySet<CompatFeature>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: modelId, messages: toWireMessages(messages), stream: true };
  if (!unsupported.has('stream_options')) body.stream_options = { include_usage: true };
  if (options.tools?.length) {
    body.tools = toWireTools(options.tools);
    body.tool_choice = 'auto';
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.jsonSchema && !unsupported.has('response_format')) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: schemaName(options.jsonSchema.name),
        schema: options.jsonSchema.schema,
        strict: false,
      },
    };
  }
  return body;
}

/** The optional field a server complained about, if the request can be retried without it. */
export function rejectedFeature(
  status: number,
  responseBody: string,
  sent: Record<string, unknown>,
): CompatFeature | undefined {
  if (status !== 400 && status !== 422) return undefined;
  const text = responseBody.toLowerCase();
  return COMPAT_FEATURES.find((feature) => feature in sent && text.includes(feature));
}

/** Model ids from a `GET /models` response; undefined when the payload is not a model list. */
export function parseModelList(payload: unknown): string[] | undefined {
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : undefined;
  if (!entries) return undefined;
  return entries.flatMap((entry: unknown) => {
    if (typeof entry === 'string') return [entry];
    if (!isRecord(entry)) return [];
    const id = [entry.id, entry.name, entry.model].find((v) => typeof v === 'string');
    return typeof id === 'string' ? [id] : [];
  });
}

/** The error message of an error object sent inside the stream, if the chunk is one. */
export function streamErrorMessage(chunk: unknown): string | undefined {
  if (!isRecord(chunk) || chunk.error == null) return undefined;
  return messageFromPayload(chunk) ?? JSON.stringify(chunk.error);
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Turns `chat.completion.chunk` payloads into stream events. Text is passed through as it arrives;
 * tool-call deltas are merged by index (id and name first, arguments in pieces) and released at the end.
 */
export class StreamAssembler {
  /** Calls in order of appearance, with the wire index they arrived under. */
  private readonly calls: { index: number; call: PartialCall }[] = [];
  /** The call that further deltas with this wire index belong to. */
  private readonly byIndex = new Map<number, PartialCall>();
  private lastIndex: number | undefined;
  private finishReason: string | undefined;
  private usage: { inputTokens: number; outputTokens: number } | undefined;

  /** Consumes one chunk (or a complete non-streamed completion) and returns the text it carries. */
  push(chunk: unknown): string {
    if (!isRecord(chunk)) return '';
    this.readUsage(chunk.usage);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices.find((c: unknown) => isRecord(c) && (c.index ?? 0) === 0);
    if (!isRecord(choice)) return '';
    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;

    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    const message = !delta && isRecord(choice.message) ? choice.message : undefined;
    const part = delta ?? message;
    if (!part) return '';
    if (Array.isArray(part.tool_calls)) {
      part.tool_calls.forEach((call: unknown, position: number) =>
        this.addToolCall(call, message ? position : undefined),
      );
    }
    return typeof part.content === 'string' ? part.content : '';
  }

  /** Events that close the stream: completed tool calls, usage and `done`. */
  finish(): ChatStreamEvent[] {
    const events: ChatStreamEvent[] = [];
    const ordered = [...this.calls].sort((a, b) => a.index - b.index);
    for (const { index, call } of ordered) {
      if (!call.name && !call.arguments) continue;
      const args = call.arguments.trim() === '' ? '{}' : call.arguments;
      events.push({
        type: 'tool-call',
        call: { id: call.id || `call_${index}`, name: call.name, arguments: args },
      });
    }
    const hasToolCalls = events.length > 0;
    if (this.usage) events.push({ type: 'usage', ...this.usage });
    events.push({ type: 'done', finishReason: this.mapFinishReason(hasToolCalls) });
    return events;
  }

  private mapFinishReason(hasToolCalls: boolean): 'stop' | 'tool-calls' | 'length' | 'other' {
    switch (this.finishReason) {
      case 'tool_calls':
      case 'function_call':
        return 'tool-calls';
      case 'length':
        return 'length';
      case 'stop':
      case undefined:
        // Several servers (Ollama, some vLLM versions) report "stop" for turns that call tools.
        return hasToolCalls ? 'tool-calls' : 'stop';
      default:
        return 'other';
    }
  }

  private readUsage(usage: unknown): void {
    if (!isRecord(usage)) return;
    const input = num(usage.prompt_tokens) ?? num(usage.input_tokens);
    const output = num(usage.completion_tokens) ?? num(usage.output_tokens);
    // Keep the latest report only: some servers repeat cumulative usage in every chunk.
    if (input !== undefined || output !== undefined)
      this.usage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  }

  private addToolCall(delta: unknown, position: number | undefined): void {
    if (!isRecord(delta)) return;
    const id = typeof delta.id === 'string' ? delta.id : '';
    const index = num(delta.index) ?? position ?? this.indexWithoutHint(id);
    let call = this.byIndex.get(index);
    // OpenAI sends an id only with the first delta of a call. A different id after complete arguments is a
    // new call from a server that numbers parallel calls all alike; before that, it only renames the call.
    if (!call || (id && call.id && call.id !== id && isCompleteJson(call.arguments))) {
      call = { id: '', name: '', arguments: '' };
      this.byIndex.set(index, call);
      this.calls.push({ index, call });
    }
    this.lastIndex = index;
    if (id) call.id = id;
    const fn = isRecord(delta.function) ? delta.function : undefined;
    if (!fn) return;
    if (typeof fn.name === 'string' && fn.name) call.name = fn.name;
    if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
    else if (isRecord(fn.arguments)) call.arguments += JSON.stringify(fn.arguments);
  }

  /** For servers that omit `index`: a new id starts a new call, otherwise the delta continues the last one. */
  private indexWithoutHint(id: string): number {
    for (const [index, call] of this.byIndex) if (id && call.id === id) return index;
    if (!id && this.lastIndex !== undefined) return this.lastIndex;
    return this.byIndex.size === 0 ? 0 : Math.max(...this.byIndex.keys()) + 1;
  }
}

function isCompleteJson(text: string): boolean {
  if (!text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
