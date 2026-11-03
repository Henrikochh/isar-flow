import { describe, expect, it, vi } from 'vitest';
import { PROBE_TOOL, probeFailureKind, probeModel } from '../../src/models/probe';
import {
  type ChatMessage,
  type ChatModel,
  type ChatOptions,
  type ChatStreamEvent,
  ModelError,
  type ModelErrorKind,
} from '../../src/models/types';

type Reply = ChatStreamEvent[] | Error | ((signal?: AbortSignal) => AsyncIterable<ChatStreamEvent>);

interface Request {
  messages: ChatMessage[];
  options: ChatOptions;
}

/** A model that answers each request with the next scripted reply and records the requests. */
function scriptedModel(replies: Reply[], init: { jsonSchema?: boolean; provider?: string } = {}) {
  const requests: Request[] = [];
  const provider = init.provider ?? 'litellm';
  const model: ChatModel = {
    ref: `${provider}/gpt-4.1`,
    provider,
    providerLabel: provider === 'vscode' ? 'VS Code' : 'LiteLLM',
    id: 'gpt-4.1',
    name: 'gpt-4.1',
    capabilities: { tools: true, jsonSchema: init.jsonSchema ?? false },
    chat(messages, options = {}) {
      requests.push({ messages, options });
      const reply = replies.shift() ?? [];
      if (typeof reply === 'function') return reply(options.signal);
      return (async function* () {
        if (reply instanceof Error) throw reply;
        yield* reply;
      })();
    },
  };
  return { model, requests };
}

const call = (name = 'get_weather', args = '{"city":"Munich"}', id = 'call_1'): ChatStreamEvent => ({
  type: 'tool-call',
  call: { id, name, arguments: args },
});
const text = (value: string): ChatStreamEvent => ({ type: 'text', text: value });
const done: ChatStreamEvent = { type: 'done', finishReason: 'stop' };
const JSON_ANSWER = [text('{"city": "Munich", "temperature": 18}'), done];

/** A clock that advances 400 ms per reading, so the probe's latency is predictable. */
function clock() {
  let t = 1_000;
  return () => (t += 400);
}

/** Never answers; ends only when its request is aborted (or never, with `ignoreAbort`). */
const hanging =
  (ignoreAbort = false) =>
  (signal?: AbortSignal): AsyncIterable<ChatStreamEvent> => ({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<ChatStreamEvent>>((_, reject) => {
          if (!ignoreAbort)
            signal?.addEventListener('abort', () => reject(new ModelError('stopped', 'aborted')));
        }),
    }),
  });

describe('probeModel', () => {
  it('reports working native tool calls and a readable JSON answer', async () => {
    const { model, requests } = scriptedModel([[call(), done], JSON_ANSWER], { jsonSchema: true });

    const result = await probeModel(model, { now: clock() });

    expect(result).toEqual({
      ref: 'litellm/gpt-4.1',
      outcome: 'tools',
      message: 'Tool calls work',
      toolCalls: true,
      json: true,
      latencyMs: 400,
      testedAt: 1_800,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].messages).toEqual([
      {
        role: 'user',
        content: 'Call the tool "get_weather" with {"city": "Munich"}. Do not write anything else.',
      },
    ]);
    expect(requests[0].options).toMatchObject({ tools: [PROBE_TOOL], temperature: 0 });
    expect(PROBE_TOOL.parameters).toMatchObject({
      properties: { city: { type: 'string' } },
      required: ['city'],
    });

    // The JSON request continues after the tool result and asks for the schema the model supports.
    const second = requests[1];
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(second.messages[1]).toMatchObject({ toolCalls: [{ id: 'call_1', name: 'get_weather' }] });
    expect(second.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call_1', name: 'get_weather' });
    expect(second.options.jsonSchema?.schema).toMatchObject({ required: ['city', 'temperature'] });
    expect(second.options.temperature).toBe(0);
  });

  it('answers every tool call of the first reply', async () => {
    const { model, requests } = scriptedModel([
      [call('get_weather', '{"city":"Munich"}', 'a'), call('get_weather', '{"city":"Berlin"}', 'b'), done],
      JSON_ANSWER,
    ]);
    await probeModel(model);
    const tools = requests[1].messages.filter((m) => m.role === 'tool');
    expect(tools.map((m) => (m.role === 'tool' ? m.toolCallId : ''))).toEqual(['a', 'b']);
  });

  it('leaves out the JSON schema for models without support', async () => {
    const { model, requests } = scriptedModel([[call(), done], JSON_ANSWER], { jsonSchema: false });
    await probeModel(model);
    expect(requests[1].options.jsonSchema).toBeUndefined();
  });

  it('says that the JSON answer could not be read', async () => {
    const { model } = scriptedModel([
      [call(), done],
      [text('It is sunny in Munich.'), done],
    ]);
    const result = await probeModel(model);
    expect(result).toMatchObject({
      outcome: 'tools',
      message: 'Tool calls work; the JSON answer could not be read',
      toolCalls: true,
      json: false,
    });
  });

  it('counts a failing JSON request as an unreadable JSON answer', async () => {
    const { model } = scriptedModel([
      [call(), done],
      new ModelError('response_format is invalid', 'bad-request'),
    ]);
    const result = await probeModel(model);
    expect(result).toMatchObject({ outcome: 'tools', toolCalls: true, json: false });
  });

  it('needs text tool mode when the model writes the call as text', async () => {
    const { model, requests } = scriptedModel([
      [text('<tool_call>{"name": "get_weather", "arguments": {"city": "Munich"}}</tool_call>'), done],
      JSON_ANSWER,
    ]);
    const result = await probeModel(model);
    expect(result).toMatchObject({
      outcome: 'text',
      message: 'Needs text tool mode',
      toolCalls: false,
      json: true,
    });
    // Without a call the JSON question is a fresh request without tools.
    expect(requests[1].messages).toHaveLength(1);
    expect(requests[1].messages[0].role).toBe('user');
    expect(requests[1].options.tools).toBeUndefined();
  });

  it('needs text tool mode when the model answers without any call', async () => {
    const { model } = scriptedModel([
      [text('The weather in Munich is fine.'), done],
      [text('no json'), done],
    ]);
    expect(await probeModel(model)).toMatchObject({ outcome: 'text', toolCalls: false, json: false });
  });

  it('needs text tool mode when the endpoint refuses tools for the model', async () => {
    const refused = new ModelError(
      "The provider 'Ollama' rejected the request (HTTP 400): gemma does not support tools",
      'bad-request',
      400,
    );
    const { model, requests } = scriptedModel([refused, JSON_ANSWER]);
    expect(await probeModel(model)).toMatchObject({ outcome: 'text', toolCalls: false, json: true });
    expect(requests[1].options.tools).toBeUndefined();
  });

  it.each<[ModelErrorKind, string, string]>([
    ['auth', 'HTTP 401', 'The API key was rejected. Set a new API key for LiteLLM.'],
    ['not-found', 'missing', "The endpoint doesn't know this model. Check the model id or refresh models."],
    ['network', 'refused', "Can't reach LiteLLM. Check that it is running and the base URL is right."],
    ['rate-limit', 'slow down', 'The endpoint is rate limiting requests. Try again in a minute.'],
    [
      'bad-request',
      "The provider 'LiteLLM' rejected the request (HTTP 400): temperature must be <= 1",
      'The endpoint rejected the test request: temperature must be <= 1.',
    ],
    ['server', 'The provider had a server error (HTTP 500).', 'The provider had a server error (HTTP 500).'],
  ])('reports %s errors with a fix', async (kind, raw, message) => {
    const { model } = scriptedModel([new ModelError(raw, kind)]);
    const result = await probeModel(model, { now: clock() });
    expect(result).toMatchObject({
      outcome: 'failed',
      message,
      toolCalls: false,
      json: false,
      latencyMs: 400,
    });
  });

  it('keeps the error text of VS Code models, which need no API key', async () => {
    const error = new ModelError("Isar Flow may not use the VS Code model 'GPT' yet.", 'auth');
    const { model } = scriptedModel([error], { provider: 'vscode' });
    expect((await probeModel(model)).message).toBe(error.message);
  });

  it('reports errors that are not model errors', async () => {
    const { model } = scriptedModel([new Error('boom')]);
    expect(await probeModel(model)).toMatchObject({ outcome: 'failed', message: 'boom' });
  });

  it('gives up after the timeout, also when the model ignores the abort', async () => {
    for (const ignoreAbort of [false, true]) {
      const { model, requests } = scriptedModel([hanging(ignoreAbort)]);
      const result = await probeModel(model, { timeoutMs: 20 });
      expect(result).toMatchObject({ outcome: 'failed', message: "The model didn't answer within 1 s." });
      expect(requests[0].options.signal?.aborted).toBe(true);
    }
  });

  it('waits 60 s by default', async () => {
    vi.useFakeTimers();
    try {
      const { model } = scriptedModel([hanging()]);
      let settled = false;
      const pending = probeModel(model).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).message).toBe("The model didn't answer within 60 s.");
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when the caller aborts, so nothing is cached', async () => {
    const controller = new AbortController();
    const { model } = scriptedModel([hanging(true)]);
    const pending = probeModel(model, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });

    const { model: other, requests } = scriptedModel([JSON_ANSWER]);
    await expect(probeModel(other, { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(requests).toEqual([]);
  });
});

describe('probeFailureKind', () => {
  it('finds the fix of a failed probe from its message', async () => {
    const kinds: ModelErrorKind[] = ['auth', 'not-found', 'network', 'rate-limit', 'bad-request'];
    const found = [];
    for (const kind of kinds) {
      const { model } = scriptedModel([new ModelError('x', kind)]);
      found.push(probeFailureKind((await probeModel(model)).message));
    }
    expect(found).toEqual(kinds);
    const { model } = scriptedModel([hanging()]);
    expect(probeFailureKind((await probeModel(model, { timeoutMs: 5 })).message)).toBe('timeout');
    expect(probeFailureKind('Tool calls work')).toBeUndefined();
  });
});
