import { extractJson } from '../agent/json';
import {
  type ChatMessage,
  type ChatModel,
  type ChatModelInfo,
  type ChatOptions,
  ModelError,
  type ModelErrorKind,
  type ModelProbeOutcome,
  type ModelProbeResult,
  type ToolCall,
  type ToolSpec,
} from './types';

export const PROBE_TIMEOUT_MS = 60_000;

export interface ProbeOptions {
  /** Aborting rejects the probe (nothing to cache); the timeout instead resolves with outcome 'failed'. */
  signal?: AbortSignal;
  now?: () => number;
  timeoutMs?: number;
}

/** The kinds of failures a "Test model" fix can address. */
export type ProbeFailureKind = 'auth' | 'not-found' | 'network' | 'rate-limit' | 'bad-request' | 'timeout';

export const PROBE_TOOL: ToolSpec = {
  name: 'get_weather',
  description: 'Returns the current weather of a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'Name of the city' } },
    required: ['city'],
    additionalProperties: false,
  },
};

const TOOL_PROMPT = 'Call the tool "get_weather" with {"city": "Munich"}. Do not write anything else.';
const TOOL_RESULT = '{"city": "Munich", "temperature": 18, "condition": "sunny"}';
const JSON_AFTER_CALL =
  'Now answer with only a JSON object with the keys "city" (string) and "temperature" (number) from the ' +
  'tool result. Do not call tools.';
const JSON_FRESH =
  'Answer with only this JSON object and nothing else: {"city": "Munich", "temperature": 18}';
const JSON_SCHEMA: NonNullable<ChatOptions['jsonSchema']> = {
  name: 'weather',
  schema: {
    type: 'object',
    properties: { city: { type: 'string' }, temperature: { type: 'number' } },
    required: ['city', 'temperature'],
    additionalProperties: false,
  },
};

/** VS Code models explain their own failures (permissions, sign-in); they have no API key or base URL. */
const VSCODE_PROVIDER = 'vscode';

const MESSAGES = {
  tools: 'Tool calls work',
  toolsWithoutJson: 'Tool calls work; the JSON answer could not be read',
  text: 'Needs text tool mode',
};

const FAILURE_STARTS: [ProbeFailureKind, string][] = [
  ['auth', 'The API key was rejected.'],
  ['not-found', "The endpoint doesn't know this model."],
  ['network', "Can't reach "],
  ['rate-limit', 'The endpoint is rate limiting requests.'],
  ['bad-request', 'The endpoint rejected the test request'],
  ['timeout', "The model didn't answer within "],
];

/**
 * "Test model": asks for one native tool call, then for one JSON answer, and measures the whole exchange.
 * Never rejects for model problems (they become outcome 'failed'); rejects only when `signal` aborts.
 */
export async function probeModel(model: ChatModel, options: ProbeOptions = {}): Promise<ModelProbeResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  const started = now();
  const result = (outcome: ModelProbeOutcome, message: string, toolCalls = false, json = false) => {
    const testedAt = now();
    return { ref: model.ref, outcome, message, toolCalls, json, latencyMs: testedAt - started, testedAt };
  };

  const controller = new AbortController();
  let timedOut = false;
  let stop!: (reason: ModelError) => void;
  // Settles the race even when a model ignores the abort signal.
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => undefined);
  const onAbort = () => {
    controller.abort();
    stop(cancelled());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    stop(new ModelError('The model test timed out.', 'aborted'));
  }, timeoutMs);

  try {
    const { toolCalls, json } = await Promise.race([exchange(model, controller.signal), stopped]);
    if (!toolCalls) return result('text', MESSAGES.text, false, json);
    return result('tools', json ? MESSAGES.tools : MESSAGES.toolsWithoutJson, true, json);
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (timedOut) return result('failed', `The model didn't answer within ${seconds(timeoutMs)} s.`);
    return result('failed', failureMessage(model, error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Which fix a failed probe needs, read from its message; undefined for other messages. */
export function probeFailureKind(message: string): ProbeFailureKind | undefined {
  return FAILURE_STARTS.find(([, start]) => message.startsWith(start))?.[0];
}

async function exchange(
  model: ChatModel,
  signal: AbortSignal,
): Promise<{ toolCalls: boolean; json: boolean }> {
  const ask: ChatMessage = { role: 'user', content: TOOL_PROMPT };
  let calls: ToolCall[] = [];
  let said = '';
  try {
    ({ calls, text: said } = await turn(model, [ask], { tools: [PROBE_TOOL], temperature: 0, signal }));
  } catch (error) {
    // Ollama and others answer HTTP 400 for models without tool support: that model needs text tool mode.
    if (!refusesTools(error)) throw error;
  }

  const messages: ChatMessage[] = calls.length
    ? [
        ask,
        { role: 'assistant', content: said, toolCalls: calls },
        ...calls.map((call): ChatMessage => ({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: TOOL_RESULT,
        })),
        { role: 'user', content: JSON_AFTER_CALL },
      ]
    : [{ role: 'user', content: JSON_FRESH }];
  let json = false;
  try {
    const answer = await turn(model, messages, {
      // Some endpoints (Anthropic through LiteLLM) need the tools whenever the conversation has tool calls.
      tools: calls.length ? [PROBE_TOOL] : undefined,
      temperature: 0,
      jsonSchema: model.capabilities.jsonSchema ? JSON_SCHEMA : undefined,
      signal,
    });
    json = readsAsJsonObject(answer.text);
  } catch (error) {
    if (signal.aborted) throw error;
    // The tool call worked; a failing JSON request only means the JSON answer could not be read.
  }
  return { toolCalls: calls.length > 0, json };
}

async function turn(
  model: ChatModel,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<{ text: string; calls: ToolCall[] }> {
  let text = '';
  const calls: ToolCall[] = [];
  for await (const event of model.chat(messages, options)) {
    if (event.type === 'text') text += event.text;
    else if (event.type === 'tool-call') calls.push(event.call);
  }
  return { text, calls };
}

function readsAsJsonObject(text: string): boolean {
  try {
    const value = extractJson(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function refusesTools(error: unknown): boolean {
  return error instanceof ModelError && error.kind === 'bad-request' && /\btools?\b/i.test(error.message);
}

function failureMessage(model: ChatModelInfo, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (model.provider === VSCODE_PROVIDER) return text;
  const kind: ModelErrorKind = error instanceof ModelError ? error.kind : 'other';
  switch (kind) {
    case 'auth':
      return `The API key was rejected. Set a new API key for ${model.providerLabel}.`;
    case 'not-found':
      return "The endpoint doesn't know this model. Check the model id or refresh models.";
    case 'network':
      return `Can't reach ${model.providerLabel}. Check that it is running and the base URL is right.`;
    case 'rate-limit':
      return 'The endpoint is rate limiting requests. Try again in a minute.';
    case 'bad-request':
      return `The endpoint rejected the test request: ${sentence(serverDetail(text))}`;
    default:
      return text;
  }
}

/** The server's explanation inside a client error message ("… rejected the request (HTTP 400): <detail>"). */
function serverDetail(message: string): string {
  return /\(HTTP \d+\):\s*(.+)$/s.exec(message)?.[1] ?? message;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function cancelled(): ModelError {
  return new ModelError('The model test was cancelled.', 'aborted');
}
