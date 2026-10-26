import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  /** Path without the query string, e.g. `/v1/chat/completions`. */
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** Parsed JSON body; undefined when the body is empty or not JSON. */
  json: unknown;
}

export type MockHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

/**
 * A real HTTP server on a random local port that speaks just enough of the OpenAI API for tests.
 * Routes are scripted per test; every request is recorded.
 */
export class MockOpenAIServer {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, { handlers: MockHandler[]; calls: number }>();
  private readonly server = createServer((req, res) => void this.handle(req, res));
  private port = 0;

  static async start(): Promise<MockOpenAIServer> {
    const mock = new MockOpenAIServer();
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    mock.port = (mock.server.address() as AddressInfo).port;
    return mock;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Scripts a route. Handlers answer consecutive requests in order; the last one repeats. */
  on(method: string, path: string, ...handlers: MockHandler[]): this {
    this.routes.set(`${method.toUpperCase()} ${path}`, { handlers, calls: 0 });
    return this;
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.socket.setNoDelay(true);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: (req.url ?? '/').split('?')[0],
      headers: req.headers,
      body,
      json: parseJson(body),
    };
    this.requests.push(recorded);

    const route = this.routes.get(`${recorded.method} ${recorded.path}`);
    if (!route || route.handlers.length === 0) {
      await reply.error(404, `No route for ${recorded.method} ${recorded.path}`)(recorded, res);
      return;
    }
    const handler = route.handlers[Math.min(route.calls, route.handlers.length - 1)];
    route.calls++;
    try {
      await handler(recorded, res);
    } catch {
      res.destroy();
    }
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
/** Lets each chunk leave as its own write without the multi-millisecond timer granularity of Windows. */
const yieldToIo = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Encodes events as SSE text: objects become JSON, strings are sent as-is; `[DONE]` is appended by default. */
export function sseText(events: unknown[], done = true): string {
  const lines = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  if (done) lines.push('data: [DONE]\n\n');
  return lines.join('');
}

async function writeChunked(res: ServerResponse, text: string, chunkSize: number): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += chunkSize) {
    res.write(bytes.subarray(i, i + chunkSize));
    await yieldToIo();
  }
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
}

export interface SseReplyOptions {
  /** Write the body in pieces of this many bytes (splits events and multi-byte characters). */
  chunkSize?: number;
  /** Append `data: [DONE]` (default true). */
  done?: boolean;
}

export const reply = {
  json(body: unknown, status = 200, headers: Record<string, string> = {}): MockHandler {
    return (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
  },

  /** OpenAI-style error body: `{ error: { message } }`. */
  error(status: number, message: string, headers: Record<string, string> = {}): MockHandler {
    return reply.json({ error: { message, type: 'invalid_request_error' } }, status, headers);
  },

  text(status: number, body: string, headers: Record<string, string> = {}): MockHandler {
    return (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
      res.end(body);
    };
  },

  sse(events: unknown[], options: SseReplyOptions = {}): MockHandler {
    return reply.raw(sseText(events, options.done ?? true), options.chunkSize);
  },

  /** Streams exact SSE text, optionally in small byte chunks. */
  raw(text: string, chunkSize = 1 << 16): MockHandler {
    return async (_req, res) => {
      startSse(res);
      await writeChunked(res, text, chunkSize);
      res.end();
    };
  },

  /** Streams the events, then kills the connection without finishing the response. */
  sseThenDrop(events: unknown[]): MockHandler {
    return async (_req, res) => {
      startSse(res);
      await writeChunked(res, sseText(events, false), 1 << 16);
      await pause();
      res.socket?.destroy();
    };
  },

  /** Streams the events, then keeps the connection open until the client goes away. */
  sseThenHang(events: unknown[]): MockHandler {
    return async (_req, res) => {
      startSse(res);
      await writeChunked(res, sseText(events, false), 1 << 16);
      await new Promise<void>((resolve) => res.on('close', () => resolve()));
    };
  },

  /** Sends 200 headers, then kills the connection before any body byte. */
  dropBeforeBody(): MockHandler {
    return async (_req, res) => {
      startSse(res);
      await pause();
      res.socket?.destroy();
    };
  },
};

const BASE_CHUNK = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model' };

/** Builders for OpenAI `chat.completion.chunk` payloads. */
export const chunk = {
  role(): object {
    return {
      ...BASE_CHUNK,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    };
  },
  text(content: string): object {
    return { ...BASE_CHUNK, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
  },
  toolCall(index: number, part: { id?: string; name?: string; args?: string }): object {
    const call: Record<string, unknown> = { index };
    if (part.id !== undefined) call.id = part.id;
    if (part.id !== undefined) call.type = 'function';
    const fn: Record<string, unknown> = {};
    if (part.name !== undefined) fn.name = part.name;
    if (part.args !== undefined) fn.arguments = part.args;
    call.function = fn;
    return { ...BASE_CHUNK, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] };
  },
  finish(reason: string): object {
    return { ...BASE_CHUNK, choices: [{ index: 0, delta: {}, finish_reason: reason }] };
  },
  usage(promptTokens: number, completionTokens: number): object {
    return {
      ...BASE_CHUNK,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  },
};
