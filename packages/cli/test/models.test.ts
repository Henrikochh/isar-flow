import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelError, type StepIO } from '@isar-flow/core';
import { chunk, MockOpenAIServer, reply } from '../../core/test/fakes/mockOpenAIServer';
import { createCliModelResolver, providerEnvName } from '../src/models';

let server: MockOpenAIServer;

beforeEach(async () => {
  server = await MockOpenAIServer.start();
  server.on('POST', '/v1/chat/completions', reply.sse([chunk.role(), chunk.text('hi')]));
});
afterEach(() => server.close());

const io = (): StepIO => ({
  runId: 'r',
  stepId: 's',
  signal: new AbortController().signal,
  log: () => undefined,
});

async function chatOnce(resolver: ReturnType<typeof createCliModelResolver>, ref: string): Promise<string> {
  const model = await resolver.resolve(ref);
  let text = '';
  for await (const event of model.chat([{ role: 'user', content: 'hello' }], { signal: io().signal })) {
    if (event.type === 'text') text += event.text;
  }
  return text;
}

const rejection = async (promise: Promise<unknown>): Promise<ModelError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelError) return error;
    throw error;
  }
  throw new Error('Expected a ModelError');
};

describe('createCliModelResolver', () => {
  it('names the environment variables of a provider', () => {
    expect(providerEnvName('my-llm', 'BASE_URL')).toBe('ISARFLOW_MY_LLM_BASE_URL');
  });

  it('uses providers of the config file with the key from apiKeyEnv', async () => {
    const resolver = createCliModelResolver({
      config: {
        providers: [
          { id: 'local', baseUrl: `${server.url}/v1`, apiKeyEnv: 'LOCAL_KEY', headers: { 'X-Team': 'a' } },
        ],
      },
      env: { LOCAL_KEY: 'sk-local' },
    });
    expect(await chatOnce(resolver, 'local/qwen')).toBe('hi');
    const [request] = server.requestsTo('/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer sk-local');
    expect(request.headers['x-team']).toBe('a');
    expect(request.json).toMatchObject({ model: 'qwen' });
    expect(server.requestsTo('/v1/models')).toHaveLength(0);
  });

  it('falls back to ISARFLOW_<ID>_API_KEY and sends no key when none is set', async () => {
    const config = { providers: [{ id: 'local', baseUrl: `${server.url}/v1` }] };
    await chatOnce(createCliModelResolver({ config, env: { ISARFLOW_LOCAL_API_KEY: 'sk-env' } }), 'local/a');
    await chatOnce(createCliModelResolver({ config, env: {} }), 'local/a');
    const [withKey, withoutKey] = server.requestsTo('/v1/chat/completions');
    expect(withKey.headers.authorization).toBe('Bearer sk-env');
    expect(withoutKey.headers.authorization).toBeUndefined();
  });

  it('uses providers from environment variables without a config file', async () => {
    const resolver = createCliModelResolver({
      config: {},
      env: { ISARFLOW_OLLAMA_BASE_URL: `${server.url}/v1` },
    });
    const model = await resolver.resolve('ollama/llama3.2');
    expect(model).toMatchObject({ ref: 'ollama/llama3.2', provider: 'ollama' });
    expect(await chatOnce(resolver, 'ollama/llama3.2')).toBe('hi');
  });

  it('explains that VS Code models are not available', async () => {
    const error = await rejection(
      createCliModelResolver({ config: {}, env: {} }).resolve('vscode/copilot/gpt-4o'),
    );
    expect(error.message).toBe(
      "VS Code models (vscode/…) aren't available on the command line. Add an OpenAI-compatible provider to .isarflow/config.yaml and use its models.",
    );
    expect(error.kind).toBe('not-found');
  });

  it('explains how to configure an unknown provider', async () => {
    const error = await rejection(createCliModelResolver({ config: {}, env: {} }).resolve('my-llm/x'));
    expect(error.message).toBe(
      "Provider 'my-llm' isn't configured. Add it to .isarflow/config.yaml or set ISARFLOW_MY_LLM_BASE_URL.",
    );
    expect(error.kind).toBe('not-found');
  });

  it('refuses references without a provider', async () => {
    await expect(createCliModelResolver({ config: {}, env: {} }).resolve('gpt-4o')).rejects.toThrow(
      /Invalid model reference 'gpt-4o'/,
    );
  });
});
