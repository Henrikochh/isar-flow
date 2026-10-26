import {
  type ChatMessage,
  type ChatModel,
  type ChatModelInfo,
  type ChatOptions,
  type ChatStreamEvent,
  ModelError,
  type ToolCall,
} from '@isar-flow/core';
import * as vscode from 'vscode';
import { isRecord, VSCODE_PROVIDER_ID } from './settings';

export const VSCODE_PROVIDER_LABEL = 'VS Code';

const JUSTIFICATION = 'Isar Flow runs an agent block of your workflow.';

type ToolMessage = Extract<ChatMessage, { role: 'tool' }>;

interface ConvertedMessage {
  message: vscode.LanguageModelChatMessage;
  /** Plain text of the message, used to estimate tokens when the model cannot count them. */
  text: string;
}

export function compareModelNames(a: ChatModelInfo, b: ChatModelInfo): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export function vsCodeModelInfo(model: vscode.LanguageModelChat): ChatModelInfo {
  const id = `${model.vendor}/${model.id}`;
  return {
    ref: `${VSCODE_PROVIDER_ID}/${id}`,
    provider: VSCODE_PROVIDER_ID,
    providerLabel: VSCODE_PROVIDER_LABEL,
    id,
    name: model.name || model.id,
    family: model.family || undefined,
    capabilities: { tools: true, jsonSchema: false },
    maxInputTokens: Number.isFinite(model.maxInputTokens) ? model.maxInputTokens : undefined,
  };
}

/** The chat models VS Code offers (Copilot and other extensions), sorted by name. */
export async function listVsCodeModels(
  lm: Pick<typeof vscode.lm, 'selectChatModels'>,
): Promise<ChatModelInfo[]> {
  const byRef = new Map<string, ChatModelInfo>();
  for (const model of await lm.selectChatModels()) {
    const info = vsCodeModelInfo(model);
    if (!byRef.has(info.ref)) byRef.set(info.ref, info);
  }
  return [...byRef.values()].sort(compareModelNames);
}

export function wrapVsCodeModel(model: vscode.LanguageModelChat): ChatModel {
  return { ...vsCodeModelInfo(model), chat: (messages, options) => chat(model, messages, options ?? {}) };
}

async function* chat(
  model: vscode.LanguageModelChat,
  messages: ChatMessage[],
  options: ChatOptions,
): AsyncGenerator<ChatStreamEvent, void, undefined> {
  const { signal } = options;
  if (signal?.aborted) throw cancelledError(model);
  const converted = toVsCodeMessages(messages);
  const cts = new vscode.CancellationTokenSource();
  const onAbort = () => cts.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  let streamed = false;
  try {
    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(
        converted.map((c) => c.message),
        requestOptions(options),
        cts.token,
      );
    } catch (error) {
      throw signal?.aborted ? cancelledError(model) : mapLanguageModelError(error, model);
    }

    let text = '';
    const calls: ToolCall[] = [];
    try {
      for await (const part of response.stream) {
        if (signal?.aborted) throw cancelledError(model);
        if (part instanceof vscode.LanguageModelTextPart) {
          if (!part.value) continue;
          text += part.value;
          yield { type: 'text', text: part.value };
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          const call: ToolCall = {
            id: part.callId,
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          };
          calls.push(call);
          yield { type: 'tool-call', call };
        }
      }
    } catch (error) {
      throw signal?.aborted ? cancelledError(model) : mapLanguageModelError(error, model);
    }
    if (signal?.aborted) throw cancelledError(model);
    streamed = true;

    const usage = await estimateUsage(model, converted, text, calls, cts.token);
    if (signal?.aborted) throw cancelledError(model);
    yield { type: 'usage', ...usage };
    yield { type: 'done', finishReason: calls.length ? 'tool-calls' : 'stop' };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Stops the model when the caller stopped reading or the stream failed.
    if (!streamed) cts.cancel();
    cts.dispose();
  }
}

/**
 * Converts the conversation for the VS Code API, which has no system role: system prompts become user
 * messages, and the results of one round of tool calls are sent together in one user message.
 */
export function toVsCodeMessages(messages: ChatMessage[]): ConvertedMessage[] {
  const converted: ConvertedMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    switch (message.role) {
      case 'system': {
        const text = `Instructions:\n${message.content}`;
        converted.push({ message: vscode.LanguageModelChatMessage.User(text), text });
        break;
      }
      case 'user':
        converted.push({
          message: vscode.LanguageModelChatMessage.User(message.content),
          text: message.content,
        });
        break;
      case 'assistant':
        converted.push(assistantMessage(message));
        break;
      case 'tool': {
        const group: ToolMessage[] = [message];
        for (let next = messages[i + 1]; next?.role === 'tool'; next = messages[i + 1]) {
          group.push(next);
          i++;
        }
        converted.push(toolResultMessage(group));
        break;
      }
    }
  }
  return converted;
}

function assistantMessage(message: Extract<ChatMessage, { role: 'assistant' }>): ConvertedMessage {
  const calls = message.toolCalls ?? [];
  if (!calls.length) {
    return { message: vscode.LanguageModelChatMessage.Assistant(message.content), text: message.content };
  }
  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
  if (message.content) parts.push(new vscode.LanguageModelTextPart(message.content));
  for (const call of calls)
    parts.push(new vscode.LanguageModelToolCallPart(call.id, call.name, toolInput(call.arguments)));
  const text = [message.content, ...calls.map((c) => `${c.name}${c.arguments}`)].join('');
  return { message: vscode.LanguageModelChatMessage.Assistant(parts), text };
}

function toolResultMessage(results: ToolMessage[]): ConvertedMessage {
  const texts = results.map((result) => {
    // Some models reject empty text blocks.
    const content = result.content || '(no output)';
    return result.isError && !/^error\b/i.test(content) ? `Error: ${content}` : content;
  });
  const parts = results.map(
    (result, index) =>
      new vscode.LanguageModelToolResultPart(result.toolCallId, [
        new vscode.LanguageModelTextPart(texts[index]),
      ]),
  );
  return { message: vscode.LanguageModelChatMessage.User(parts), text: texts.join('\n') };
}

/** The API needs the arguments as an object; unparsable arguments are sent as an empty object. */
function toolInput(args: string): object {
  try {
    const value: unknown = JSON.parse(args);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function requestOptions(options: ChatOptions): vscode.LanguageModelChatRequestOptions {
  const request: vscode.LanguageModelChatRequestOptions = { justification: JUSTIFICATION };
  if (options.tools?.length) {
    request.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));
  }
  const modelOptions: Record<string, number> = {};
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.maxTokens !== undefined) modelOptions.max_tokens = options.maxTokens;
  if (Object.keys(modelOptions).length) request.modelOptions = modelOptions;
  return request;
}

/** VS Code reports no usage, so it is counted with the model's tokenizer (or estimated when that fails). */
async function estimateUsage(
  model: vscode.LanguageModelChat,
  converted: ConvertedMessage[],
  text: string,
  calls: ToolCall[],
  token: vscode.CancellationToken,
): Promise<{ inputTokens: number; outputTokens: number }> {
  const count = async (input: string | vscode.LanguageModelChatMessage, plain: string): Promise<number> => {
    try {
      const tokens = await model.countTokens(input, token);
      return Number.isFinite(tokens) && tokens >= 0 ? tokens : roughTokens(plain);
    } catch {
      return roughTokens(plain);
    }
  };
  const outputs = [text, ...calls.map((c) => `${c.name}${c.arguments}`)].filter(Boolean);
  const [input, output] = await Promise.all([
    Promise.all(converted.map((c) => count(c.message, c.text))),
    Promise.all(outputs.map((o) => count(o, o))),
  ]);
  return { inputTokens: sum(input), outputTokens: sum(output) };
}

const roughTokens = (text: string) => Math.ceil(text.length / 4);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function cancelledError(model: vscode.LanguageModelChat): ModelError {
  return new ModelError(
    `The request to the VS Code model '${model.name || model.id}' was cancelled.`,
    'aborted',
  );
}

/** Turns errors of the VS Code language model API into ModelErrors with a message that says how to fix them. */
export function mapLanguageModelError(
  error: unknown,
  model: Pick<vscode.LanguageModelChat, 'name' | 'id'>,
): ModelError {
  if (error instanceof ModelError) return error;
  const name = model.name || model.id;
  const detail = errorDetail(error);
  let mapped: ModelError;
  if (error instanceof vscode.LanguageModelError) {
    switch (error.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        mapped = new ModelError(
          `Isar Flow may not use the VS Code model '${name}' yet. Allow Isar Flow to use this model when VS Code asks. ` +
            'If you declined earlier, allow it again under Accounts > Manage Language Model Access.',
          'auth',
        );
        break;
      case vscode.LanguageModelError.NotFound.name:
        mapped = new ModelError(
          `The VS Code model '${name}' is no longer available. Check that the extension that provides it ` +
            '(for example GitHub Copilot) is installed and signed in, or pick another model.',
          'not-found',
        );
        break;
      case vscode.LanguageModelError.Blocked.name:
        mapped = new ModelError(
          `VS Code blocked the request to the model '${name}', for example because a usage limit was reached. ` +
            `Wait a while and try again, or pick another model.${detail ? ` Details: ${detail}` : ''}`,
          'rate-limit',
        );
        break;
      default:
        mapped = new ModelError(`The VS Code model '${name}' failed: ${detail || 'unknown error'}`, 'server');
    }
  } else {
    mapped = new ModelError(`The VS Code model '${name}' failed: ${detail || 'unknown error'}`, 'other');
  }
  mapped.cause = error;
  return mapped;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    if (error.cause instanceof Error && error.cause.message) return error.cause.message;
    return error.message;
  }
  return typeof error === 'string' ? error : '';
}
