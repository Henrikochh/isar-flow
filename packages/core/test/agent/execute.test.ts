import { describe, expect, it } from 'vitest';
import { executeAgentRequest } from '../../src/agent';
import type { AgentRequest } from '../../src/engine/types';
import { type ChatModel, ModelError, type ModelResolver } from '../../src/models/types';
import { callTools, FakeModel, say } from '../fakes/fakeModel';
import { FakeToolHost, recordingIO } from './helpers';

function request(
  overrides: Partial<AgentRequest> = {},
  agent: Partial<AgentRequest['agent']> = {},
): AgentRequest {
  return {
    stepId: 'review',
    agentId: 'reviewer',
    agent: { name: 'Reviewer', model: 'main/model', systemPrompt: 'Be strict.', ...agent },
    prompt: 'Review the change.',
    history: [],
    contextFiles: [],
    ...overrides,
  };
}

class MapResolver implements ModelResolver {
  readonly resolved: string[] = [];

  constructor(private readonly models: Record<string, ChatModel | Error>) {}

  async resolve(ref: string): Promise<ChatModel> {
    this.resolved.push(ref);
    const entry = this.models[ref];
    if (!entry) throw new Error(`Unknown model "${ref}". Check the provider settings.`);
    if (entry instanceof Error) throw entry;
    return entry;
  }
}

describe('executeAgentRequest', () => {
  it('runs the agent with its settings and returns the result', async () => {
    const main = new FakeModel([say('Approved.', { inputTokens: 9, outputTokens: 2 })], {
      ref: 'main/model',
    });
    const io = recordingIO();

    const result = await executeAgentRequest(request({}, { temperature: 0.3, maxTokens: 100 }), {
      resolver: new MapResolver({ 'main/model': main }),
      io,
    });

    expect(result).toEqual({
      text: 'Approved.',
      model: 'main/model',
      usage: { inputTokens: 9, outputTokens: 2 },
      turns: 1,
      messages: [
        { role: 'user', content: 'Review the change.' },
        { role: 'assistant', content: 'Approved.' },
      ],
    });
    expect(main.calls[0].messages[0]).toEqual({ role: 'system', content: 'Be strict.' });
    expect(main.calls[0].options).toMatchObject({ temperature: 0.3, maxTokens: 100 });
  });

  it('uses the agent tools, permissions and maxTurns', async () => {
    const host = new FakeToolHost({ readFile: () => ({ content: 'x' }) });
    const main = new FakeModel(
      [
        callTools({ name: 'readFile', args: { path: 'a.ts' } }),
        callTools({ name: 'readFile', args: { path: 'b.ts' } }),
      ],
      { ref: 'main/model' },
    );
    const agent = { tools: ['readFile' as const], permissions: { edits: 'auto' as const }, maxTurns: 2 };

    await expect(
      executeAgentRequest(request({}, agent), {
        resolver: new MapResolver({ 'main/model': main }),
        io: recordingIO(),
        toolHost: host,
      }),
    ).rejects.toThrow(/all 2 turns/);
    expect(host.calls[0].permissions).toEqual({ edits: 'auto' });
    expect(main.calls[0].options.tools?.map((t) => t.name)).toEqual(['readFile']);
  });

  it('returns parsed JSON and continues a session from history', async () => {
    const history = [
      { role: 'user' as const, content: 'Earlier' },
      { role: 'assistant' as const, content: '{"approved": false}' },
    ];
    const main = new FakeModel([say('{"approved": true}')], { ref: 'main/model' });
    const result = await executeAgentRequest(
      request({ history, output: { format: 'json', schema: { approved: 'boolean' } } }),
      { resolver: new MapResolver({ 'main/model': main }), io: recordingIO() },
    );
    expect(result.json).toEqual({ approved: true });
    expect(main.calls[0].messages.slice(1, 3)).toEqual(history);
    expect(result.messages.slice(0, 2)).toEqual(history);
    expect(result.messages).toHaveLength(4);
  });

  describe('context files', () => {
    it('appends files as fenced blocks labelled with their paths', async () => {
      const main = new FakeModel([say('ok')], { ref: 'main/model' });
      const io = recordingIO();
      const seen: { globs: string[]; signal: AbortSignal }[] = [];

      await executeAgentRequest(request({ contextFiles: ['src/**/*.ts', 'README.md'] }), {
        resolver: new MapResolver({ 'main/model': main }),
        io,
        readContextFiles: async (globs, signal) => {
          seen.push({ globs, signal });
          return [
            { path: 'src/app.ts', content: 'export const a = 1;\n' },
            { path: 'README.md', content: 'Use ```code``` blocks' },
          ];
        },
      });

      expect(seen).toEqual([{ globs: ['src/**/*.ts', 'README.md'], signal: io.signal }]);
      expect(main.calls[0].messages[1].content).toBe(
        [
          'Review the change.',
          '',
          'Context files:',
          '',
          '```src/app.ts',
          'export const a = 1;',
          '```',
          '',
          '````README.md',
          'Use ```code``` blocks',
          '````',
        ].join('\n'),
      );
      expect(io.textOf('info')).toMatch(/Attached 2 context files/);
    });

    it('handles large files with very many backtick runs', async () => {
      const main = new FakeModel([say('ok')], { ref: 'main/model' });
      const content = `${'Use `x` here. '.repeat(150_000)}and \`\`\`\`\`five\`\`\`\`\``;
      await executeAgentRequest(request({ contextFiles: ['docs/api.md'] }), {
        resolver: new MapResolver({ 'main/model': main }),
        io: recordingIO(),
        readContextFiles: async () => [{ path: 'docs/api.md', content }],
      });
      const prompt = main.calls[0].messages[1].content;
      expect(prompt).toContain(`\n\`\`\`\`\`\`docs/api.md\n${content}\n\`\`\`\`\`\``);
    });

    it('stops without calling a model when cancelled while files are read', async () => {
      const main = new FakeModel([say('ok')], { ref: 'main/model' });
      const io = recordingIO();
      const resolver = new MapResolver({ 'main/model': main });
      await expect(
        executeAgentRequest(request({ contextFiles: ['a.ts'] }), {
          resolver,
          io,
          readContextFiles: async () => {
            io.controller.abort();
            return [{ path: 'a.ts', content: 'x' }];
          },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(resolver.resolved).toEqual([]);
    });

    it('leaves the prompt alone when no files match', async () => {
      const main = new FakeModel([say('ok')], { ref: 'main/model' });
      const io = recordingIO();
      await executeAgentRequest(request({ contextFiles: ['docs/*.md'] }), {
        resolver: new MapResolver({ 'main/model': main }),
        io,
        readContextFiles: async () => [],
      });
      expect(main.calls[0].messages[1].content).toBe('Review the change.');
      expect(io.textOf('info')).toMatch(/No files matched the context globs: docs\/\*\.md/);
    });

    it('does not read files when none are requested', async () => {
      const main = new FakeModel([say('ok')], { ref: 'main/model' });
      let called = false;
      await executeAgentRequest(request(), {
        resolver: new MapResolver({ 'main/model': main }),
        io: recordingIO(),
        readContextFiles: async () => ((called = true), []),
      });
      expect(called).toBe(false);
    });

    it('logs when context files cannot be read in this environment', async () => {
      const main = new FakeModel([say('ok')], { ref: 'main/model' });
      const io = recordingIO();
      await executeAgentRequest(request({ contextFiles: ['a.ts'] }), {
        resolver: new MapResolver({ 'main/model': main }),
        io,
      });
      expect(main.calls[0].messages[1].content).toBe('Review the change.');
      expect(io.textOf('info')).toMatch(/cannot be attached/);
    });
  });

  describe('fallback models', () => {
    it('falls back when the main model is not found', async () => {
      const fallback = new FakeModel([say('From fallback')], { ref: 'backup/model' });
      const resolver = new MapResolver({
        'main/model': new ModelError('Model "model" was not found at main.', 'not-found', 404),
        'backup/model': fallback,
      });
      const io = recordingIO();

      const result = await executeAgentRequest(request({}, { fallbackModels: ['backup/model'] }), {
        resolver,
        io,
      });

      expect(result.model).toBe('backup/model');
      expect(result.text).toBe('From fallback');
      expect(resolver.resolved).toEqual(['main/model', 'backup/model']);
      expect(io.textOf('info')).toBe(
        'Model main/model failed: Model "model" was not found at main. Trying fallback model backup/model.\n',
      );
    });

    it('falls back when the resolver cannot provide the model', async () => {
      const fallback = new FakeModel([say('ok')], { ref: 'backup/model' });
      const resolver = new MapResolver({ 'backup/model': fallback });
      const result = await executeAgentRequest(request({}, { fallbackModels: ['backup/model'] }), {
        resolver,
        io: recordingIO(),
      });
      expect(result.model).toBe('backup/model');
    });

    it.each(['rate-limit', 'server', 'network', 'not-found'] as const)(
      'falls back when the model fails with %s while answering',
      async (kind) => {
        const main = new FakeModel([{ error: new ModelError(`failed: ${kind}`, kind) }], {
          ref: 'main/model',
        });
        const fallback = new FakeModel([say('ok')], { ref: 'backup/model' });
        const result = await executeAgentRequest(request({}, { fallbackModels: ['backup/model'] }), {
          resolver: new MapResolver({ 'main/model': main, 'backup/model': fallback }),
          io: recordingIO(),
        });
        expect(result.model).toBe('backup/model');
      },
    );

    it.each(['auth', 'bad-request'] as const)('does not fall back on %s errors', async (kind) => {
      const main = new FakeModel([{ error: new ModelError(`Main failed (${kind}).`, kind) }], {
        ref: 'main/model',
      });
      const fallback = new FakeModel([say('ok')], { ref: 'backup/model' });
      const resolver = new MapResolver({ 'main/model': main, 'backup/model': fallback });
      await expect(
        executeAgentRequest(request({}, { fallbackModels: ['backup/model'] }), {
          resolver,
          io: recordingIO(),
        }),
      ).rejects.toThrow(`Main failed (${kind}).`);
      expect(fallback.calls).toHaveLength(0);
    });

    it('does not fall back when the resolver reports an auth problem', async () => {
      const resolver = new MapResolver({
        'main/model': new ModelError(
          'No API key set for provider "main". Run "Isar Flow: Set provider key".',
          'auth',
        ),
        'backup/model': new FakeModel([say('ok')], { ref: 'backup/model' }),
      });
      await expect(
        executeAgentRequest(request({}, { fallbackModels: ['backup/model'] }), {
          resolver,
          io: recordingIO(),
        }),
      ).rejects.toThrow(/No API key/);
      expect(resolver.resolved).toEqual(['main/model']);
    });

    it('does nothing when the step is already cancelled', async () => {
      const io = recordingIO();
      io.controller.abort();
      const resolver = new MapResolver({ 'main/model': new FakeModel([say('ok')], { ref: 'main/model' }) });
      await expect(executeAgentRequest(request(), { resolver, io })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(resolver.resolved).toEqual([]);
    });

    it('does not fall back when the resolver fails because of a cancel', async () => {
      const io = recordingIO();
      const resolved: string[] = [];
      const resolver: ModelResolver = {
        resolve: async (ref) => {
          resolved.push(ref);
          io.controller.abort();
          throw new Error('Request cancelled');
        },
      };
      await expect(
        executeAgentRequest(request({}, { fallbackModels: ['backup/model'] }), { resolver, io }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(resolved).toEqual(['main/model']);
      expect(io.textOf('info')).toBe('');
    });

    it('does not fall back after a cancel', async () => {
      const io = recordingIO();
      const main = new FakeModel([{ text: ['a', 'b'], onStream: () => io.controller.abort() }], {
        ref: 'main/model',
      });
      const fallback = new FakeModel([say('ok')], { ref: 'backup/model' });
      await expect(
        executeAgentRequest(request({}, { fallbackModels: ['backup/model'] }), {
          resolver: new MapResolver({ 'main/model': main, 'backup/model': fallback }),
          io,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(fallback.calls).toHaveLength(0);
    });

    it('continues the conversation on the fallback model without repeating tool calls', async () => {
      const host = new FakeToolHost({ editFile: () => ({ content: 'Edited a.ts' }) });
      const main = new FakeModel(
        [
          {
            ...callTools({ id: 'e1', name: 'editFile', args: { path: 'a.ts', oldText: 'a', newText: 'b' } }),
            usage: { inputTokens: 5, outputTokens: 5 },
          },
          { error: new ModelError('Too many requests.', 'rate-limit', 429) },
        ],
        { ref: 'main/model' },
      );
      const fallback = new FakeModel([say('Done.', { inputTokens: 3, outputTokens: 1 })], {
        ref: 'backup/model',
      });

      const result = await executeAgentRequest(
        request({}, { tools: ['editFile'], fallbackModels: ['backup/model'] }),
        {
          resolver: new MapResolver({ 'main/model': main, 'backup/model': fallback }),
          io: recordingIO(),
          toolHost: host,
        },
      );

      expect(host.calls).toHaveLength(1);
      expect(fallback.calls[0].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
      expect(result).toMatchObject({
        text: 'Done.',
        model: 'backup/model',
        turns: 2,
        usage: { inputTokens: 8, outputTokens: 6 },
      });
      expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    });

    it('rethrows the error unchanged when there is no fallback', async () => {
      const error = new ModelError('Model "x" was not found.', 'not-found', 404);
      await expect(
        executeAgentRequest(request(), {
          resolver: new MapResolver({ 'main/model': error }),
          io: recordingIO(),
        }),
      ).rejects.toBe(error);
    });

    it('names every model when all of them fail', async () => {
      const resolver = new MapResolver({
        'main/model': new ModelError('Server error 503 from main.', 'server', 503),
        'backup/model': new ModelError('Model not found at backup.', 'not-found', 404),
      });
      await expect(
        executeAgentRequest(request({}, { fallbackModels: ['backup/model', 'main/model'] }), {
          resolver,
          io: recordingIO(),
        }),
      ).rejects.toThrow(
        'No model could answer. main/model: Server error 503 from main. backup/model: Model not found at backup. Check the provider settings or choose other models.',
      );
      expect(resolver.resolved).toEqual(['main/model', 'backup/model']);
    });
  });
});
