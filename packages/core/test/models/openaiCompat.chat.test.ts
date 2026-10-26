import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAICompatClient, type OpenAICompatConfig } from '../../src/models/openaiCompat';
import { type ChatMessage, type ChatStreamEvent, ModelError } from '../../src/models/types';
import { chunk, MockOpenAIServer, reply } from '../fakes/mockOpenAIServer';

const CHAT = '/v1/chat/completions';

let server: MockOpenAIServer;

beforeEach(async () => {
  server = await MockOpenAIServer.start();
});

afterEach(async () => {
  await server.close();
});

function client(config: Partial<OpenAICompatConfig> = {}) {
  return new OpenAICompatClient({
    id: 'litellm',
    label: 'LiteLLM',
    baseUrl: `${server.url}/v1`,
    retry: { attempts: 3, baseDelayMs: 1 },
    ...config,
  });
}

const hello: ChatMessage[] = [{ role: 'user', content: 'Say hello' }];
const helloStream = [chunk.role(), chunk.text('Hel'), chunk.text('lo'), chunk.finish('stop')];

async function collect(events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Collects events until the stream fails; returns both. */
async function collectUntilError(events: AsyncIterable<ChatStreamEvent>) {
  const out: ChatStreamEvent[] = [];
  try {
    for await (const event of events) out.push(event);
  } catch (error) {
    return { events: out, error };
  }
  return { events: out, error: undefined };
}

const textOf = (events: ChatStreamEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');

describe('streaming', () => {
  it('streams text deltas and finishes', async () => {
    server.on('POST', CHAT, reply.sse(helloStream, { chunkSize: 3 }));
    const events = await collect(client().model('gpt-4.1').chat(hello));
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('posts the expected request to <base>/chat/completions', async () => {
    server.on('POST', CHAT, reply.sse(helloStream));
    const messages: ChatMessage[] = [{ role: 'system', content: 'Be brief.' }, ...hello];
    await collect(
      client({ baseUrl: `${server.url}/v1/`, apiKey: 'sk-1' })
        .model('gpt-4.1')
        .chat(messages),
    );

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request.path).toBe(CHAT);
    expect(request.headers['content-type']).toContain('application/json');
    expect(request.headers.accept).toContain('text/event-stream');
    expect(request.headers.authorization).toBe('Bearer sk-1');
    expect(request.json).toEqual({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Say hello' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('handles CRLF line endings and comment lines', async () => {
    const text = `: PROCESSING\r\n\r\ndata: ${JSON.stringify(chunk.text('ok'))}\r\n\r\ndata: [DONE]\r\n\r\n`;
    server.on('POST', CHAT, reply.raw(text, 5));
    expect(await collect(client().model('m').chat(hello))).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('finds <base>/v1 for chat calls even when the models were never listed', async () => {
    server.on('POST', CHAT, reply.sse(helloStream));
    const model = client({ baseUrl: server.url }).model('m');
    expect(textOf(await collect(model.chat(hello)))).toBe('Hello');
    expect(textOf(await collect(model.chat(hello)))).toBe('Hello');
    expect(server.requests.map((r) => r.path)).toEqual(['/chat/completions', CHAT, CHAT]);
  });

  it('reports usage once, using the last report of servers that repeat it', async () => {
    server.on(
      'POST',
      CHAT,
      reply.sse([
        { ...chunk.text('a'), usage: { prompt_tokens: 10, completion_tokens: 1 } },
        { ...chunk.text('b'), usage: { prompt_tokens: 10, completion_tokens: 2 } },
        chunk.finish('stop'),
      ]),
    );
    const events = await collect(client().model('m').chat(hello));
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 2 },
    ]);
  });

  it('emits usage reported at the end of the stream', async () => {
    server.on('POST', CHAT, reply.sse([chunk.text('ok'), chunk.finish('stop'), chunk.usage(12, 5)]));
    expect(await collect(client().model('m').chat(hello))).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'usage', inputTokens: 12, outputTokens: 5 },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it.each([
    ['length', 'length'],
    ['content_filter', 'other'],
    ['stop', 'stop'],
  ])('maps finish reason %s to %s', async (reason, expected) => {
    server.on('POST', CHAT, reply.sse([chunk.text('x'), chunk.finish(reason)]));
    const events = await collect(client().model('m').chat(hello));
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: expected });
  });

  it('finishes with stop when the stream ends without a finish reason or [DONE]', async () => {
    server.on('POST', CHAT, reply.sse([chunk.text('x')], { done: false }));
    const events = await collect(client().model('m').chat(hello));
    expect(events).toEqual([
      { type: 'text', text: 'x' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('accepts servers that ignore stream: true and answer with plain JSON', async () => {
    server.on(
      'POST',
      CHAT,
      reply.json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Plain answer',
              tool_calls: [
                { id: 'call_x', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );
    expect(await collect(client().model('m').chat(hello))).toEqual([
      { type: 'text', text: 'Plain answer' },
      { type: 'tool-call', call: { id: 'call_x', name: 'search', arguments: '{"q":"x"}' } },
      { type: 'usage', inputTokens: 3, outputTokens: 4 },
      { type: 'done', finishReason: 'tool-calls' },
    ]);
  });

  it('raises errors that the provider sends inside the stream', async () => {
    server.on(
      'POST',
      CHAT,
      reply.sse([chunk.text('a'), { error: { message: 'Upstream overloaded', code: 502 } }]),
    );
    const { events, error } = await collectUntilError(client().model('m').chat(hello));
    expect(events).toEqual([{ type: 'text', text: 'a' }]);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).message).toContain('Upstream overloaded');
    expect(server.requests).toHaveLength(1);
  });

  it('reports an answer without any stream events instead of an empty reply', async () => {
    const page = '<!doctype html><html><head><title>Open WebUI</title></head><body></body></html>';
    server.on('POST', CHAT, reply.text(200, page, { 'Content-Type': 'text/html; charset=utf-8' }));
    const { events, error } = await collectUntilError(client().model('m').chat(hello));
    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ kind: 'other' });
    expect((error as ModelError).message).toContain("'LiteLLM'");
    expect((error as ModelError).message).toContain('base URL');
  });

  it('reports malformed stream events', async () => {
    server.on('POST', CHAT, reply.sse(['{not json']));
    await expect(collect(client().model('m').chat(hello))).rejects.toThrow(/malformed/);
  });
});

describe('tool calls', () => {
  /** Splits text into pieces of `size` characters. */
  const pieces = (text: string, size: number) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu')) ?? [];

  it('assembles two parallel tool calls whose arguments arrive in many pieces', async () => {
    const argsA = '{"path":"src/app.ts","line":12}';
    const argsB = '{"query":"TODO äö 🌊"}';
    const deltasA = pieces(argsA, 3).map((args) => chunk.toolCall(0, { args }));
    const deltasB = pieces(argsB, 2).map((args) => chunk.toolCall(1, { args }));
    const interleaved = [];
    for (let i = 0; i < Math.max(deltasA.length, deltasB.length); i++) {
      if (deltasA[i]) interleaved.push(deltasA[i]);
      if (deltasB[i]) interleaved.push(deltasB[i]);
    }
    server.on(
      'POST',
      CHAT,
      reply.sse(
        [
          chunk.role(),
          chunk.text('Let me '),
          chunk.text('check.'),
          chunk.toolCall(0, { id: 'call_a', name: 'read_file', args: '' }),
          chunk.toolCall(1, { id: 'call_b', name: 'search', args: '' }),
          ...interleaved,
          chunk.finish('tool_calls'),
          chunk.usage(40, 22),
        ],
        { chunkSize: 13 },
      ),
    );

    const events = await collect(client().model('m').chat(hello));
    expect(events).toEqual([
      { type: 'text', text: 'Let me ' },
      { type: 'text', text: 'check.' },
      { type: 'tool-call', call: { id: 'call_a', name: 'read_file', arguments: argsA } },
      { type: 'tool-call', call: { id: 'call_b', name: 'search', arguments: argsB } },
      { type: 'usage', inputTokens: 40, outputTokens: 22 },
      { type: 'done', finishReason: 'tool-calls' },
    ]);
    const calls = events.flatMap((e) => (e.type === 'tool-call' ? [JSON.parse(e.call.arguments)] : []));
    expect(calls).toEqual([{ path: 'src/app.ts', line: 12 }, { query: 'TODO äö 🌊' }]);
  });

  it('accepts complete tool calls without an index and a stop finish reason', async () => {
    const delta = (call: object) => ({
      choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
    });
    server.on(
      'POST',
      CHAT,
      reply.sse([
        delta({ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '' } }),
        delta({ id: 'call_2', type: 'function', function: { name: 'search', arguments: '{"q":"a"}' } }),
        chunk.finish('stop'),
      ]),
    );
    expect(await collect(client().model('m').chat(hello))).toEqual([
      { type: 'tool-call', call: { id: 'call_1', name: 'list_files', arguments: '{}' } },
      { type: 'tool-call', call: { id: 'call_2', name: 'search', arguments: '{"q":"a"}' } },
      { type: 'done', finishReason: 'tool-calls' },
    ]);
  });

  it('keeps parallel calls apart when a server numbers them all with index 0', async () => {
    server.on(
      'POST',
      CHAT,
      reply.sse([
        chunk.toolCall(0, { id: 'call_a', name: 'read_file', args: '{"path":"a.ts"}' }),
        chunk.toolCall(0, { id: 'call_b', name: 'read_file', args: '{"path":"b.ts"}' }),
        chunk.finish('tool_calls'),
      ]),
    );
    expect(await collect(client().model('m').chat(hello))).toEqual([
      { type: 'tool-call', call: { id: 'call_a', name: 'read_file', arguments: '{"path":"a.ts"}' } },
      { type: 'tool-call', call: { id: 'call_b', name: 'read_file', arguments: '{"path":"b.ts"}' } },
      { type: 'done', finishReason: 'tool-calls' },
    ]);
  });

  it('keeps merging argument pieces when a server repeats a changing id on every delta', async () => {
    server.on(
      'POST',
      CHAT,
      reply.sse([
        chunk.toolCall(0, { id: 'call_1', name: 'search', args: '{"q":' }),
        chunk.toolCall(0, { id: 'call_2', args: '"x"}' }),
        chunk.finish('tool_calls'),
      ]),
    );
    const events = await collect(client().model('m').chat(hello));
    const calls = events.filter((e) => e.type === 'tool-call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call: { name: 'search', arguments: '{"q":"x"}' } });
  });

  it('turns argument objects of a plain JSON answer into JSON text', async () => {
    server.on(
      'POST',
      CHAT,
      reply.json({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', function: { name: 'search', arguments: { q: 'x' } } }],
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    expect(await collect(client().model('m').chat(hello))).toEqual([
      { type: 'tool-call', call: { id: 'c1', name: 'search', arguments: '{"q":"x"}' } },
      { type: 'done', finishReason: 'tool-calls' },
    ]);
  });

  it('sends tools, sampling options and the JSON schema response format', async () => {
    server.on('POST', CHAT, reply.sse(helloStream));
    const schema = { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] };
    const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    await collect(
      client()
        .model('m')
        .chat(hello, {
          tools: [{ name: 'read_file', description: 'Read a file', parameters }],
          temperature: 0.2,
          maxTokens: 256,
          jsonSchema: { name: 'review', schema },
        }),
    );
    expect(server.requests[0].json).toMatchObject({
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters } }],
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 256,
      response_format: { type: 'json_schema', json_schema: { name: 'review', schema, strict: false } },
    });
  });

  it('sends temperature 0 and turns the schema name into a name OpenAI accepts', async () => {
    server.on('POST', CHAT, reply.sse(helloStream));
    await collect(
      client()
        .model('m')
        .chat(hello, { temperature: 0, jsonSchema: { name: 'review result (v2)', schema: {} } }),
    );
    expect(server.requests[0].json).toMatchObject({
      temperature: 0,
      response_format: { json_schema: { name: 'review_result__v2_' } },
    });
  });

  it('omits tools and tool_choice for an empty tool list', async () => {
    server.on('POST', CHAT, reply.sse(helloStream));
    await collect(client().model('m').chat(hello, { tools: [] }));
    expect(server.requests[0].json).not.toHaveProperty('tools');
    expect(server.requests[0].json).not.toHaveProperty('tool_choice');
  });

  it('maps assistant tool calls and tool results to the OpenAI format', async () => {
    server.on('POST', CHAT, reply.sse(helloStream));
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Fix it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
          { id: 'call_2', name: 'search', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'const a = 1;' },
      { role: 'tool', toolCallId: 'call_2', name: 'search', content: 'No matches', isError: true },
      {
        role: 'assistant',
        content: 'Thinking',
        toolCalls: [{ id: 'call_3', name: 'search', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'call_3', name: 'search', content: 'one match' },
      { role: 'assistant', content: 'Done.' },
    ];
    await collect(client().model('m').chat(messages));
    expect((server.requests[0].json as { messages: unknown }).messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Fix it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          { id: 'call_2', type: 'function', function: { name: 'search', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'const a = 1;' },
      { role: 'tool', tool_call_id: 'call_2', content: 'No matches' },
      {
        role: 'assistant',
        content: 'Thinking',
        tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_3', content: 'one match' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});

describe('compatibility fallbacks', () => {
  it('retries once without stream_options when the server rejects it, and remembers that', async () => {
    server.on(
      'POST',
      CHAT,
      reply.error(400, 'Unrecognized request argument supplied: stream_options'),
      reply.sse(helloStream),
    );
    const model = client().model('m');
    expect(textOf(await collect(model.chat(hello)))).toBe('Hello');
    await collect(model.chat(hello));

    const bodies = server.requests.map((r) => r.json);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveProperty('stream_options');
    expect(bodies[1]).not.toHaveProperty('stream_options');
    expect(bodies[2]).not.toHaveProperty('stream_options');
  });

  it('retries once without response_format when the server rejects it', async () => {
    server.on(
      'POST',
      CHAT,
      reply.error(400, "'response_format.type' json_schema is not supported"),
      reply.sse(helloStream),
    );
    const events = await collect(
      client()
        .model('m')
        .chat(hello, { jsonSchema: { name: 'out', schema: { type: 'object' } } }),
    );
    expect(textOf(events)).toBe('Hello');
    const [first, second] = server.requests.map((r) => r.json);
    expect(first).toHaveProperty('response_format');
    expect(second).not.toHaveProperty('response_format');
    expect(second).toHaveProperty('stream_options');
  });

  it('also drops a field the server rejects with HTTP 422', async () => {
    server.on(
      'POST',
      CHAT,
      reply.error(422, 'Extra inputs are not permitted: stream_options'),
      reply.sse(helloStream),
    );
    expect(textOf(await collect(client().model('m').chat(hello)))).toBe('Hello');
    expect(server.requests[1].json).not.toHaveProperty('stream_options');
  });

  it('does not loop when the server keeps rejecting the request', async () => {
    server.on('POST', CHAT, reply.error(400, 'stream_options and response_format are both broken'));
    const error = await collect(
      client()
        .model('m')
        .chat(hello, { jsonSchema: { name: 'out', schema: {} } }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'bad-request', status: 400 });
    expect(server.requests).toHaveLength(3);
  });
});

describe('errors', () => {
  it('explains how to fix a rejected API key and does not retry', async () => {
    server.on('POST', CHAT, reply.error(401, 'Invalid proxy server token passed'));
    const error = await collect(client().model('m').chat(hello)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      kind: 'auth',
      status: 401,
      message:
        "Authentication failed for provider 'LiteLLM' (HTTP 401). Set the API key with 'Isar Flow: Set provider API key'.",
    });
    expect(server.requests).toHaveLength(1);
  });

  it('reports HTTP 403 as an auth problem', async () => {
    server.on('POST', CHAT, reply.error(403, 'Key not allowed to access model'));
    await expect(collect(client().model('m').chat(hello))).rejects.toMatchObject({
      kind: 'auth',
      status: 403,
    });
    expect(server.requests).toHaveLength(1);
  });

  it('explains an invalid base URL without sending anything', async () => {
    let calls = 0;
    const fetchStub: typeof fetch = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };
    const error = await collect(
      client({ baseUrl: 'localhost:11434', fetch: fetchStub }).model('m').chat(hello),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ModelError', kind: 'bad-request' });
    expect((error as ModelError).message).toContain('base URL');
    expect(calls).toBe(0);
  });

  it('reports unknown models', async () => {
    server.on('POST', CHAT, reply.error(404, 'The model `gpt-9` does not exist'));
    await expect(collect(client().model('gpt-9').chat(hello))).rejects.toMatchObject({
      kind: 'not-found',
      message: "Model 'gpt-9' was not found on provider 'LiteLLM'.",
    });
    expect(server.requests).toHaveLength(1);
  });

  it("includes the server's message for other client errors", async () => {
    server.on('POST', CHAT, reply.error(400, 'messages: at least one message is required'));
    const error = await collect(client().model('m').chat(hello)).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'bad-request', status: 400 });
    expect((error as ModelError).message).toContain('messages: at least one message is required');
    expect((error as ModelError).message).toContain('LiteLLM');
  });

  it('includes plain-text error bodies', async () => {
    server.on('POST', CHAT, reply.text(422, 'unsupported parameter: foo'));
    const error = await collect(client().model('m').chat(hello)).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'bad-request', status: 422 });
    expect((error as ModelError).message).toContain('unsupported parameter: foo');
  });

  it('reports unreachable servers as network errors after retrying', async () => {
    let calls = 0;
    const fetchStub: typeof fetch = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };
    const error = await collect(
      client({ baseUrl: 'http://127.0.0.1:9/v1', fetch: fetchStub, retry: { attempts: 2, baseDelayMs: 1 } })
        .model('m')
        .chat(hello),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      kind: 'network',
      message: 'Cannot reach http://127.0.0.1:9/v1. Is the server running?',
    });
    expect(calls).toBe(2);
  });
});

describe('retries', () => {
  it('retries a 429 and honours Retry-After', async () => {
    server.on(
      'POST',
      CHAT,
      reply.error(429, 'Rate limit reached', { 'Retry-After': '0' }),
      reply.sse(helloStream),
    );
    const started = Date.now();
    const events = await collect(
      client({ retry: { baseDelayMs: 20_000 } })
        .model('m')
        .chat(hello),
    );
    expect(textOf(events)).toBe('Hello');
    expect(server.requests).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives up after the configured attempts on server errors', async () => {
    server.on('POST', CHAT, reply.error(503, 'Service Unavailable'));
    const error = await collect(client().model('m').chat(hello)).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'server', status: 503 });
    expect((error as ModelError).message).toContain('Service Unavailable');
    expect(server.requests).toHaveLength(3);
  });

  it('retries when the connection drops before the first byte of the stream', async () => {
    server.on('POST', CHAT, reply.dropBeforeBody(), reply.sse(helloStream));
    expect(textOf(await collect(client().model('m').chat(hello)))).toBe('Hello');
    expect(server.requests).toHaveLength(2);
  });

  it('never retries once streaming has started', async () => {
    server.on('POST', CHAT, reply.sseThenDrop([chunk.text('partial')]), reply.sse(helloStream));
    const { events, error } = await collectUntilError(client().model('m').chat(hello));
    expect(events).toEqual([{ type: 'text', text: 'partial' }]);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ kind: 'network' });
    expect(server.requests).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('stops promptly when aborted mid-stream', async () => {
    server.on('POST', CHAT, reply.sseThenHang([chunk.text('first')]));
    const controller = new AbortController();
    const received: ChatStreamEvent[] = [];
    const run = (async () => {
      for await (const event of client().model('m').chat(hello, { signal: controller.signal })) {
        received.push(event);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'ModelError', kind: 'aborted' });
    expect(received).toEqual([{ type: 'text', text: 'first' }]);
  });

  it('hands out no further events after an abort, even from data already received', async () => {
    server.on('POST', CHAT, reply.sseThenHang([chunk.text('a'), chunk.text('b'), chunk.text('c')]));
    const controller = new AbortController();
    const received: ChatStreamEvent[] = [];
    const run = (async () => {
      for await (const event of client().model('m').chat(hello, { signal: controller.signal })) {
        received.push(event);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(received).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('stops handing out tool calls and done after an abort', async () => {
    server.on(
      'POST',
      CHAT,
      reply.sse([
        chunk.toolCall(0, { id: 'c1', name: 'a', args: '{}' }),
        chunk.toolCall(1, { id: 'c2', name: 'b', args: '{}' }),
        chunk.finish('tool_calls'),
      ]),
    );
    const controller = new AbortController();
    const received: ChatStreamEvent[] = [];
    const run = (async () => {
      for await (const event of client().model('m').chat(hello, { signal: controller.signal })) {
        received.push(event);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(received).toEqual([{ type: 'tool-call', call: { id: 'c1', name: 'a', arguments: '{}' } }]);
  });

  it('stops promptly when aborted while waiting for the next chunk', async () => {
    let closed = false;
    server.on('POST', CHAT, async (req, res) => {
      res.on('close', () => (closed = true));
      await reply.sseThenHang([chunk.text('first')])(req, res);
    });
    const controller = new AbortController();
    const stream = client().model('m').chat(hello, { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: 'text', text: 'first' } });
    const pending = iterator.next();
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({
      kind: 'aborted',
      message: "The request to provider 'LiteLLM' was cancelled.",
    });
    await expect.poll(() => closed, { timeout: 2_000 }).toBe(true);
  });

  it('stops waiting between retries when aborted', async () => {
    server.on('POST', CHAT, reply.error(503, 'busy'));
    const controller = new AbortController();
    const started = Date.now();
    const run = collect(
      client({ retry: { attempts: 3, baseDelayMs: 20_000 } })
        .model('m')
        .chat(hello, { signal: controller.signal }),
    );
    await expect.poll(() => server.requests.length).toBe(1);
    controller.abort();
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(server.requests).toHaveLength(1);
  });

  it('aborts while waiting for the response', async () => {
    server.on('POST', CHAT, async (_req, res) => {
      await new Promise<void>((resolve) => res.on('close', () => resolve()));
    });
    const controller = new AbortController();
    const run = collect(client().model('m').chat(hello, { signal: controller.signal }));
    // Abort only once the server holds the request; a fixed timer raced the connection setup.
    await expect.poll(() => server.requests.length).toBe(1);
    controller.abort();
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(server.requests).toHaveLength(1);
  });

  it('does not send a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(client().model('m').chat(hello, { signal: controller.signal })),
    ).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect(server.requests).toHaveLength(0);
  });

  it('releases the connection when the consumer stops early', async () => {
    let closed = false;
    server.on('POST', CHAT, async (req, res) => {
      res.on('close', () => (closed = true));
      await reply.sseThenHang([chunk.text('a'), chunk.text('b')])(req, res);
    });
    for await (const event of client().model('m').chat(hello)) {
      expect(event).toEqual({ type: 'text', text: 'a' });
      break;
    }
    await expect.poll(() => closed, { timeout: 2_000 }).toBe(true);
  });
});
