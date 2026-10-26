import { type ChatMessage, type ChatStreamEvent, ModelError } from '@isar-flow/core';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { listVsCodeModels, mapLanguageModelError, wrapVsCodeModel } from '../../../src/models/vscodeLm';

interface SentRequest {
  messages: vscode.LanguageModelChatMessage[];
  options?: vscode.LanguageModelChatRequestOptions;
  token?: vscode.CancellationToken;
}

interface FakeOptions {
  vendor?: string;
  id?: string;
  name?: string;
  parts?: unknown[];
  requestError?: unknown;
  streamError?: unknown;
  /** Called after each streamed part. */
  afterPart?: (index: number) => void;
  countTokens?: (input: string | vscode.LanguageModelChatMessage) => number;
}

function fakeModel(options: FakeOptions = {}) {
  const sent: SentRequest[] = [];
  const model: vscode.LanguageModelChat = {
    name: options.name ?? 'GPT-4.1',
    id: options.id ?? 'gpt-4.1',
    vendor: options.vendor ?? 'copilot',
    family: 'gpt-4.1',
    version: '2025-04-14',
    maxInputTokens: 64000,
    async sendRequest(messages, requestOptions, token) {
      sent.push({ messages, options: requestOptions, token });
      if (options.requestError) throw options.requestError;
      const parts = options.parts ?? [];
      async function* stream() {
        for (const [index, part] of parts.entries()) {
          yield part;
          options.afterPart?.(index);
        }
        if (options.streamError) throw options.streamError;
      }
      async function* text() {}
      return { stream: stream(), text: text() };
    },
    async countTokens(input) {
      if (options.countTokens) return options.countTokens(input);
      return typeof input === 'string' ? input.length : 10;
    },
  };
  return { model, sent };
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function failure(promise: Promise<unknown>): Promise<ModelError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ModelError);
  return error as ModelError;
}

describe('listVsCodeModels', () => {
  it('describes every model VS Code offers, sorted by name and without duplicates', async () => {
    const a = fakeModel({ name: 'GPT-4.1', id: 'gpt-4.1' }).model;
    const b = fakeModel({ name: 'Claude Sonnet 4', id: 'claude-sonnet-4' }).model;
    const lm = { selectChatModels: async () => [a, b, a] };
    const infos = await listVsCodeModels(lm);
    expect(infos.map((m) => m.ref)).toEqual(['vscode/copilot/claude-sonnet-4', 'vscode/copilot/gpt-4.1']);
    expect(infos[1]).toEqual({
      ref: 'vscode/copilot/gpt-4.1',
      provider: 'vscode',
      providerLabel: 'VS Code',
      id: 'copilot/gpt-4.1',
      name: 'GPT-4.1',
      family: 'gpt-4.1',
      capabilities: { tools: true, jsonSchema: false },
      maxInputTokens: 64000,
    });
  });
});

describe('wrapVsCodeModel', () => {
  it('carries the model info', () => {
    const chat = wrapVsCodeModel(fakeModel().model);
    expect(chat.ref).toBe('vscode/copilot/gpt-4.1');
    expect(chat.provider).toBe('vscode');
    expect(chat.capabilities).toEqual({ tools: true, jsonSchema: false });
  });

  it('maps the conversation to VS Code chat messages', async () => {
    const { model, sent } = fakeModel();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be strict.' },
      { role: 'user', content: 'Review a.ts' },
      {
        role: 'assistant',
        content: 'Reading files.',
        toolCalls: [
          { id: 'c1', name: 'readFile', arguments: '{"path":"a.ts"}' },
          { id: 'c2', name: 'listFiles', arguments: 'not json' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', name: 'readFile', content: 'export {}' },
      { role: 'tool', toolCallId: 'c2', name: 'listFiles', content: 'Invalid arguments', isError: true },
      { role: 'assistant', content: 'Looks fine.' },
    ];
    await collect(wrapVsCodeModel(model).chat(messages));

    const sentMessages = sent[0].messages;
    expect(sentMessages).toHaveLength(5);
    const [system, user, assistant, results, last] = sentMessages;

    expect(system.role).toBe(vscode.LanguageModelChatMessageRole.User);
    expect(system.content).toBe('Instructions:\nBe strict.');
    expect(user.role).toBe(vscode.LanguageModelChatMessageRole.User);
    expect(user.content).toBe('Review a.ts');

    expect(assistant.role).toBe(vscode.LanguageModelChatMessageRole.Assistant);
    const assistantParts = assistant.content as unknown[];
    expect(assistantParts[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
    expect((assistantParts[0] as vscode.LanguageModelTextPart).value).toBe('Reading files.');
    expect(assistantParts[1]).toEqual(
      new vscode.LanguageModelToolCallPart('c1', 'readFile', { path: 'a.ts' }),
    );
    expect(assistantParts[2]).toEqual(new vscode.LanguageModelToolCallPart('c2', 'listFiles', {}));

    expect(results.role).toBe(vscode.LanguageModelChatMessageRole.User);
    const resultParts = results.content as vscode.LanguageModelToolResultPart[];
    expect(resultParts).toHaveLength(2);
    expect(resultParts[0]).toBeInstanceOf(vscode.LanguageModelToolResultPart);
    expect(resultParts[0].callId).toBe('c1');
    expect(resultParts[0].content).toEqual([new vscode.LanguageModelTextPart('export {}')]);
    expect(resultParts[1].callId).toBe('c2');
    expect(resultParts[1].content).toEqual([new vscode.LanguageModelTextPart('Error: Invalid arguments')]);

    expect(last.role).toBe(vscode.LanguageModelChatMessageRole.Assistant);
    expect(last.content).toBe('Looks fine.');
  });

  it('sends only tool calls when the assistant wrote no text', async () => {
    const { model, sent } = fakeModel();
    await collect(
      wrapVsCodeModel(model).chat([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'gitDiff', arguments: '' }] },
        { role: 'tool', toolCallId: 'c1', name: 'gitDiff', content: '' },
      ]),
    );
    const parts = sent[0].messages[1].content as unknown[];
    expect(parts).toEqual([new vscode.LanguageModelToolCallPart('c1', 'gitDiff', {})]);
  });

  it('passes tools, options and the justification', async () => {
    const { model, sent } = fakeModel();
    const parameters = { type: 'object', properties: { path: { type: 'string' } } };
    await collect(
      wrapVsCodeModel(model).chat([{ role: 'user', content: 'hi' }], {
        tools: [{ name: 'readFile', description: 'Reads a file', parameters }],
        temperature: 0.2,
        maxTokens: 500,
        jsonSchema: { name: 'answer', schema: {} },
      }),
    );
    const options = sent[0].options;
    expect(options?.tools).toEqual([
      { name: 'readFile', description: 'Reads a file', inputSchema: parameters },
    ]);
    expect(options?.modelOptions).toEqual({ temperature: 0.2, max_tokens: 500 });
    expect(options?.justification).toBe('Isar Flow runs an agent block of your workflow.');
  });

  it('leaves out empty tool lists and model options', async () => {
    const { model, sent } = fakeModel();
    await collect(wrapVsCodeModel(model).chat([{ role: 'user', content: 'hi' }], { tools: [] }));
    expect(sent[0].options?.tools).toBeUndefined();
    expect(sent[0].options?.modelOptions).toBeUndefined();
  });

  it('streams text and tool calls, then usage and done', async () => {
    const { model } = fakeModel({
      parts: [
        new vscode.LanguageModelTextPart('Hel'),
        new vscode.LanguageModelTextPart(''),
        { unknown: true },
        new vscode.LanguageModelTextPart('lo'),
        new vscode.LanguageModelToolCallPart('c1', 'readFile', { path: 'a' }),
      ],
    });
    const events = await collect(
      wrapVsCodeModel(model).chat([
        { role: 'system', content: 'x' },
        { role: 'user', content: 'y' },
      ]),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'tool-call', call: { id: 'c1', name: 'readFile', arguments: '{"path":"a"}' } },
      // Input: 10 per message (fake); output: 'Hello' plus the tool call name and arguments.
      { type: 'usage', inputTokens: 20, outputTokens: 5 + 'readFile'.length + '{"path":"a"}'.length },
      { type: 'done', finishReason: 'tool-calls' },
    ]);
  });

  it('finishes with stop when no tool was called', async () => {
    const { model } = fakeModel({ parts: [new vscode.LanguageModelTextPart('ok')] });
    const events = await collect(wrapVsCodeModel(model).chat([{ role: 'user', content: 'y' }]));
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 2 });
  });

  it('estimates usage when counting tokens fails', async () => {
    const { model } = fakeModel({
      parts: [new vscode.LanguageModelTextPart('abcdefgh')],
      countTokens: () => {
        throw new Error('no tokenizer');
      },
    });
    const events = await collect(wrapVsCodeModel(model).chat([{ role: 'user', content: 'abcd' }]));
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', inputTokens: 1, outputTokens: 2 });
  });

  it('does not send a request when already cancelled', async () => {
    const { model, sent } = fakeModel();
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      collect(wrapVsCodeModel(model).chat([{ role: 'user', content: 'y' }], { signal: controller.signal })),
    );
    expect(error.kind).toBe('aborted');
    expect(sent).toHaveLength(0);
  });

  it('cancels the VS Code request when the signal aborts while streaming', async () => {
    const controller = new AbortController();
    const { model, sent } = fakeModel({
      parts: [new vscode.LanguageModelTextPart('a'), new vscode.LanguageModelTextPart('b')],
      afterPart: () => controller.abort(),
    });
    const events: ChatStreamEvent[] = [];
    const error = await failure(
      (async () => {
        for await (const e of wrapVsCodeModel(model).chat([{ role: 'user', content: 'y' }], {
          signal: controller.signal,
        })) {
          events.push(e);
        }
      })(),
    );
    expect(error.kind).toBe('aborted');
    expect(sent[0].token?.isCancellationRequested).toBe(true);
    expect(events).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('cancels the VS Code request when the caller stops reading', async () => {
    const { model, sent } = fakeModel({
      parts: [new vscode.LanguageModelTextPart('a'), new vscode.LanguageModelTextPart('b')],
    });
    for await (const event of wrapVsCodeModel(model).chat([{ role: 'user', content: 'y' }])) {
      expect(event).toEqual({ type: 'text', text: 'a' });
      break;
    }
    expect(sent[0].token?.isCancellationRequested).toBe(true);
  });

  it('leaves a finished request alone', async () => {
    const { model, sent } = fakeModel({ parts: [new vscode.LanguageModelTextPart('a')] });
    await collect(wrapVsCodeModel(model).chat([{ role: 'user', content: 'y' }]));
    expect(sent[0].token?.isCancellationRequested).toBe(false);
  });

  it('maps request errors to model errors', async () => {
    const { model } = fakeModel({ requestError: vscode.LanguageModelError.NoPermissions('denied') });
    const error = await failure(collect(wrapVsCodeModel(model).chat([{ role: 'user', content: 'y' }])));
    expect(error.kind).toBe('auth');
    expect(error.message).toContain('Allow Isar Flow to use this model when VS Code asks');
  });

  it('maps errors thrown while streaming', async () => {
    const { model } = fakeModel({
      parts: [new vscode.LanguageModelTextPart('a')],
      streamError: vscode.LanguageModelError.Blocked('quota'),
    });
    const error = await failure(collect(wrapVsCodeModel(model).chat([{ role: 'user', content: 'y' }])));
    expect(error.kind).toBe('rate-limit');
  });
});

describe('mapLanguageModelError', () => {
  const model = fakeModel({ name: 'GPT-4.1' }).model;

  it('maps the VS Code error codes', () => {
    const auth = mapLanguageModelError(vscode.LanguageModelError.NoPermissions(), model);
    expect(auth.kind).toBe('auth');
    expect(auth.message).toContain('GPT-4.1');

    const missing = mapLanguageModelError(vscode.LanguageModelError.NotFound('gone'), model);
    expect(missing.kind).toBe('not-found');
    expect(missing.message).toMatch(/no longer available/);

    const blocked = mapLanguageModelError(vscode.LanguageModelError.Blocked('Quota exceeded'), model);
    expect(blocked.kind).toBe('rate-limit');
    expect(blocked.message).toContain('Quota exceeded');
  });

  it('keeps the message of other errors', () => {
    const unknown = mapLanguageModelError(new vscode.LanguageModelError('Server hiccup'), model);
    expect(unknown.kind).toBe('server');
    expect(unknown.message).toContain('Server hiccup');

    const plain = mapLanguageModelError(new Error('boom'), model);
    expect(plain.kind).toBe('other');
    expect(plain.message).toContain('boom');
  });

  it('passes model errors through', () => {
    const original = new ModelError('x', 'network');
    expect(mapLanguageModelError(original, model)).toBe(original);
  });
});
