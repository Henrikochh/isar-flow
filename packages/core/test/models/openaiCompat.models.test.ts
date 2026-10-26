import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAICompatClient, type OpenAICompatConfig } from '../../src/models/openaiCompat';
import { type ChatStreamEvent, ModelError } from '../../src/models/types';
import { chunk, MockOpenAIServer, reply } from '../fakes/mockOpenAIServer';

let server: MockOpenAIServer;

beforeEach(async () => {
  server = await MockOpenAIServer.start();
});

afterEach(async () => {
  await server.close();
});

const modelList = (...ids: string[]) => ({
  object: 'list',
  data: ids.map((id) => ({ id, object: 'model' })),
});

function client(config: Partial<OpenAICompatConfig> = {}) {
  return new OpenAICompatClient({
    id: 'litellm',
    label: 'LiteLLM',
    baseUrl: `${server.url}/v1`,
    retry: { attempts: 2, baseDelayMs: 1 },
    ...config,
  });
}

const failingFetch: typeof fetch = async () => {
  throw new TypeError('fetch failed');
};

describe('OpenAICompatClient.listModels', () => {
  it('lists models from <base>/models, sorted by name, with the API key', async () => {
    server.on('GET', '/v1/models', reply.json(modelList('gpt-4.1', 'anthropic/claude-sonnet')));
    const models = await client({ apiKey: 'sk-test' }).listModels();
    expect(models).toEqual([
      {
        ref: 'litellm/anthropic/claude-sonnet',
        provider: 'litellm',
        providerLabel: 'LiteLLM',
        id: 'anthropic/claude-sonnet',
        name: 'anthropic/claude-sonnet',
        capabilities: { tools: true, jsonSchema: true },
      },
      {
        ref: 'litellm/gpt-4.1',
        provider: 'litellm',
        providerLabel: 'LiteLLM',
        id: 'gpt-4.1',
        name: 'gpt-4.1',
        capabilities: { tools: true, jsonSchema: true },
      },
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].method).toBe('GET');
    expect(server.requests[0].headers.authorization).toBe('Bearer sk-test');
  });

  it('strips trailing slashes from the base URL', async () => {
    server.on('GET', '/v1/models', reply.json(modelList('a')));
    await client({ baseUrl: `${server.url}/v1//` }).listModels();
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/models']);
  });

  it('sends custom headers and no Authorization header without an API key', async () => {
    server.on('GET', '/v1/models', reply.json(modelList('a')));
    await client({ headers: { 'X-Team': 'isar' } }).listModels();
    expect(server.requests[0].headers['x-team']).toBe('isar');
    expect(server.requests[0].headers.authorization).toBeUndefined();
  });

  it('falls back to <base>/v1 and remembers the prefix for chat calls', async () => {
    server.on('GET', '/v1/models', reply.json(modelList('llama3.2')));
    server.on('POST', '/v1/chat/completions', reply.sse([chunk.text('hi'), chunk.finish('stop')]));
    const ollama = client({ id: 'ollama', label: 'Ollama', baseUrl: `${server.url}/` });

    const models = await ollama.listModels();
    expect(models.map((m) => m.ref)).toEqual(['ollama/llama3.2']);

    const events: ChatStreamEvent[] = [];
    for await (const event of ollama.model('llama3.2').chat([{ role: 'user', content: 'hi' }]))
      events.push(event);
    expect(events).toContainEqual({ type: 'text', text: 'hi' });
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /models',
      'GET /v1/models',
      'POST /v1/chat/completions',
    ]);
  });

  it('does not add /v1 when the base URL already ends with it', async () => {
    const error = await client()
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ kind: 'not-found', status: 404 });
    expect((error as ModelError).message).toContain(`${server.url}/v1/models`);
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/models']);
  });

  it('merges manual models without duplicates', async () => {
    server.on('GET', '/v1/models', reply.json(modelList('gpt-4.1', 'b-model')));
    const models = await client({ models: ['gpt-4.1', 'a-manual', ' '] }).listModels();
    expect(models.map((m) => m.id)).toEqual(['a-manual', 'b-model', 'gpt-4.1']);
  });

  it('accepts model lists without the data wrapper', async () => {
    server.on('GET', '/v1/models', reply.json([{ id: 'x' }, 'y']));
    expect((await client().listModels()).map((m) => m.id)).toEqual(['x', 'y']);
  });

  it('returns the manual list when discovery fails', async () => {
    server.on('GET', '/v1/models', reply.error(500, 'database down'));
    const models = await client({ models: ['zeta', 'alpha'] }).listModels();
    expect(models.map((m) => m.ref)).toEqual(['litellm/alpha', 'litellm/zeta']);
  });

  it('throws a ModelError when discovery fails and there are no manual models', async () => {
    let calls = 0;
    const fetchStub: typeof fetch = async (input, init) => {
      calls++;
      return failingFetch(input, init);
    };
    const error = await client({ baseUrl: 'http://127.0.0.1:9/v1/', fetch: fetchStub })
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      kind: 'network',
      message: 'Cannot reach http://127.0.0.1:9/v1. Is the server running?',
    });
    expect(calls).toBe(2);
  });

  it('explains unexpected model list responses', async () => {
    server.on('GET', '/v1/models', reply.text(200, '<html>login</html>'));
    await expect(client().listModels()).rejects.toThrow(/unexpected model list/);
  });

  it('reports a rejected API key during listing as an auth error', async () => {
    server.on('GET', '/v1/models', reply.error(401, 'Invalid API key'));
    await expect(client().listModels()).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
      message:
        "Authentication failed for provider 'LiteLLM' (HTTP 401). Set the API key with 'Isar Flow: Set provider API key'.",
    });
    expect(server.requests).toHaveLength(1);
  });

  it('returns only the manual list without a request when discovery is disabled', async () => {
    const models = await client({ discoverModels: false, models: ['b', 'a', 'b'] }).listModels();
    expect(models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(server.requests).toHaveLength(0);
  });

  it('does not replace an aborted discovery with the manual list', async () => {
    server.on('GET', '/v1/models', async (_req, res) => {
      await new Promise<void>((resolve) => res.on('close', () => resolve()));
    });
    const controller = new AbortController();
    const listing = client({ models: ['manual'] }).listModels(controller.signal);
    await expect.poll(() => server.requests.length).toBe(1);
    controller.abort();
    await expect(listing).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('reports a 404 at both <base> and <base>/v1 with the URL that was configured', async () => {
    const error = await client({ baseUrl: `${server.url}/api` })
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'not-found', status: 404 });
    expect((error as ModelError).message).toContain(`${server.url}/api/models`);
    expect(server.requests.map((r) => r.path)).toEqual(['/api/models', '/api/v1/models']);
  });

  it('lets the API key replace an Authorization header from the settings', async () => {
    server.on('GET', '/v1/models', reply.json(modelList('a')));
    await client({ apiKey: 'sk-new', headers: { authorization: 'Bearer old' } }).listModels();
    expect(server.requests[0].headers.authorization).toBe('Bearer sk-new');
  });

  it.each(['localhost:4000/v1', 'http//localhost:4000', 'ftp://example.com/v1', ''])(
    'explains the invalid base URL %j instead of reporting the server as unreachable',
    async (baseUrl) => {
      let calls = 0;
      const fetchStub: typeof fetch = async (input, init) => {
        calls++;
        return failingFetch(input, init);
      };
      const error = await client({ baseUrl, fetch: fetchStub })
        .listModels()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect(error).toMatchObject({ kind: 'bad-request' });
      expect((error as ModelError).message).toContain('base URL');
      expect((error as ModelError).message).toContain("'LiteLLM'");
      expect((error as ModelError).message).toContain('http://localhost:4000/v1');
      expect(calls).toBe(0);
    },
  );

  it('still offers the manual models when the base URL is invalid', async () => {
    const models = await client({ baseUrl: 'localhost:4000', models: ['m'] }).listModels();
    expect(models.map((m) => m.ref)).toEqual(['litellm/m']);
  });

  it('explains an API key that cannot be sent without echoing the key', async () => {
    let calls = 0;
    const fetchStub: typeof fetch = async (input, init) => {
      calls++;
      return failingFetch(input, init);
    };
    const apiKey = 'sk-secret​123';
    const error = await client({ apiKey, fetch: fetchStub })
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ kind: 'bad-request' });
    expect((error as ModelError).message).toContain('API key');
    expect((error as ModelError).message).toContain('Isar Flow: Set provider API key');
    expect(JSON.stringify(error)).not.toContain('sk-secret');
    expect((error as ModelError).message).not.toContain('sk-secret');
    expect((error as ModelError).cause).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('names a custom header that cannot be sent', async () => {
    const error = await client({ headers: { 'X-Team': 'line1\nline2' }, fetch: failingFetch })
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'bad-request' });
    expect((error as ModelError).message).toContain("'X-Team'");
    expect((error as ModelError).message).not.toContain('line1');
  });

  it('builds model handles with the provider info', () => {
    const model = client().model('meta/llama-3.1');
    expect(model).toMatchObject({
      ref: 'litellm/meta/llama-3.1',
      provider: 'litellm',
      providerLabel: 'LiteLLM',
      id: 'meta/llama-3.1',
      name: 'meta/llama-3.1',
      capabilities: { tools: true, jsonSchema: true },
    });
    expect(typeof model.chat).toBe('function');
  });
});
