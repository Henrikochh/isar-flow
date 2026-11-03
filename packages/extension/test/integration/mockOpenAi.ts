import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const MOCK_MODEL_ID = 'echo-model';

interface WireMessage {
  role: string;
  content?: string | null;
}

export interface MockChatRequest {
  model: string;
  messages: WireMessage[];
  tools?: { function?: { name?: string } }[];
}

/** A scripted answer: native tool calls, or a final text. */
export type MockReply =
  { toolCalls: { name: string; arguments: Record<string, unknown> }[] } | { text: string };

export interface MockOpenAiOptions {
  /** Answers a chat request; undefined falls back to the default readFile script. */
  reply?: (request: MockChatRequest) => MockReply | undefined;
}

export interface MockOpenAiServer {
  /** Base URL without /v1, as a user would enter it. */
  readonly url: string;
  readonly chatRequests: MockChatRequest[];
  close(): Promise<void>;
}

/**
 * A minimal OpenAI-compatible server: GET /models lists one model; POST /chat/completions streams SSE.
 * By default the first turn asks for the readFile tool on notes.txt, the next turn answers with the tool result;
 * `options.reply` scripts other conversations.
 */
export async function startMockOpenAi(options: MockOpenAiOptions = {}): Promise<MockOpenAiServer> {
  const chatRequests: MockChatRequest[] = [];

  const server = http.createServer((req, res) => {
    const route = (req.url ?? '').replace(/^\/v1/, '').split('?')[0];
    if (req.method === 'GET' && route === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL_ID, object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && route === '/chat/completions') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const request = JSON.parse(body) as MockChatRequest;
        chatRequests.push(request);
        streamAnswer(res, request, options.reply?.(request));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `No route for ${req.method} ${req.url}` } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chatRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function streamAnswer(res: http.ServerResponse, request: MockChatRequest, scripted?: MockReply): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    send({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

  const toolResult = request.messages.filter((m) => m.role === 'tool').at(-1);
  const offersReadFile = request.tools?.some((t) => t.function?.name === 'readFile') ?? false;

  if (scripted && 'toolCalls' in scripted) {
    // Ids stay unique across the conversation: one more than the tool results so far.
    const first = request.messages.filter((m) => m.role === 'tool').length + 1;
    chunk({
      role: 'assistant',
      tool_calls: scripted.toolCalls.map((call, index) => ({
        index,
        id: `call_${first + index}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    });
    chunk({}, 'tool_calls');
  } else if (scripted) {
    chunk({ role: 'assistant', content: scripted.text });
    chunk({}, 'stop');
  } else if (!toolResult && offersReadFile) {
    chunk({
      role: 'assistant',
      tool_calls: [
        { index: 0, id: 'call_1', type: 'function', function: { name: 'readFile', arguments: '' } },
      ],
    });
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"notes.txt"}' } }] });
    chunk({}, 'tool_calls');
  } else {
    const marker = /Marker: (\S+)/.exec(toolResult?.content ?? '')?.[1] ?? 'no marker';
    chunk({ role: 'assistant', content: 'The marker is ' });
    chunk({ content: `${marker}.` });
    chunk({}, 'stop');
  }
  send({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  });
  res.end('data: [DONE]\n\n');
}
