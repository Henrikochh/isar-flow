import { describe, expect, it } from 'vitest';
import type {
  AgentDefinition,
  AgentPermissions,
  AgentRequest,
  ChatModel,
  ChatStreamEvent,
  ModelResolver,
  ToolHost,
  TryItEvent,
} from '@isar-flow/core';
import { buildAgentDocumentState } from '../../../src/editors/documentState';
import { buildTryItRequest, parseToolLogLine, TryItSession } from '../../../src/editors/tryIt';

const state = (text: string) =>
  buildAgentDocumentState(
    text,
    'file:///a/reviewer.agent.yaml',
    'reviewer',
    'workspace',
    'reviewer.agent.yaml',
    [],
  );

const AGENT = [
  'name: Reviewer',
  'model: litellm/claude',
  'fallbackModels: [vscode/copilot/gpt-4.1]',
  'systemPrompt: Be strict.',
  'temperature: 0.2',
  'maxTokens: 400',
  'maxTurns: 4',
  'tools: [readFile, editFile, runCommand]',
  'permissions: { edits: auto, commands: auto }',
  '',
].join('\n');

describe('buildTryItRequest', () => {
  it('builds a request from the current document', () => {
    const result = buildTryItRequest(state(AGENT), 'Review src/a.ts', [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);
    if (!result.ok) throw new Error(result.error);
    const expected: AgentRequest = {
      stepId: 'try-it',
      agentId: 'reviewer',
      agent: {
        name: 'Reviewer',
        model: 'litellm/claude',
        fallbackModels: ['vscode/copilot/gpt-4.1'],
        systemPrompt: 'Be strict.',
        temperature: 0.2,
        maxTokens: 400,
        maxTurns: 4,
        tools: ['readFile', 'editFile', 'runCommand'],
        permissions: { edits: 'ask', commands: 'ask' },
      },
      prompt: 'Review src/a.ts',
      history: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
      output: undefined,
      contextFiles: [],
    };
    expect(result.request).toEqual(expected);
  });

  it('only downgrades automatic permissions', () => {
    const text = AGENT.replace('{ edits: auto, commands: auto }', '{ edits: none, commands: ask }');
    const result = buildTryItRequest(state(text), 'x', []);
    expect(result.ok && result.request.agent.permissions).toEqual({ edits: 'none', commands: 'ask' });
  });

  it('leaves permissions unset when the agent has none', () => {
    const result = buildTryItRequest(state('name: A\nmodel: a/b\n'), 'x', []);
    expect(result.ok && result.request.agent).toEqual({ name: 'A', model: 'a/b' });
  });

  it('drops empty transcript turns', () => {
    const result = buildTryItRequest(state(AGENT), 'x', [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '' },
    ]);
    expect(result.ok && result.request.history).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('asks for a model when the agent has none', () => {
    const result = buildTryItRequest(state('name: A\n'), 'x', []);
    expect(result).toEqual({ ok: false, error: 'Choose a model for this agent before trying it.' });
  });

  it('explains schema problems with their line', () => {
    const result = buildTryItRequest(state(`${AGENT}temperature2: 9\n`), 'x', []);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^Fix the agent file before trying it: .+ \(line 10\)\.$/);
  });

  it('explains unreadable YAML', () => {
    const result = buildTryItRequest(state('name: [x\n'), 'x', []);
    expect(!result.ok && result.error).toMatch(
      /^The agent file can't be read: .+ \(line \d+\)\. Fix it in the YAML, then try again\.$/,
    );
  });

  it('accepts a bare definition', () => {
    const agent: AgentDefinition = { name: '', model: 'a/b' };
    const result = buildTryItRequest({ id: 'helper', agent, valid: true, diagnostics: [] }, 'x', []);
    expect(result.ok && result.request.agent.name).toBe('helper');
  });

  it('needs a message', () => {
    expect(buildTryItRequest(state(AGENT), '  ', [])).toEqual({
      ok: false,
      error: 'Type a message for the agent.',
    });
  });
});

describe('parseToolLogLine', () => {
  it('splits a tool log line into name, arguments and result', () => {
    expect(parseToolLogLine('readFile src/app.ts:1-20 → 20 lines\n')).toEqual({
      type: 'tool',
      name: 'readFile',
      args: 'src/app.ts:1-20',
      result: '20 lines',
    });
  });

  it('flags failures', () => {
    expect(parseToolLogLine('runCommand npm test → failed: Denied by the user')).toEqual({
      type: 'tool',
      name: 'runCommand',
      args: 'npm test',
      result: 'failed: Denied by the user',
      isError: true,
    });
  });

  it('copes with calls without arguments or result', () => {
    expect(parseToolLogLine('gitDiff')).toEqual({ type: 'tool', name: 'gitDiff', args: '' });
  });
});

/* ---------- session ---------- */

type Turn = ChatStreamEvent[] | ((signal: AbortSignal) => AsyncIterable<ChatStreamEvent>);

function fakeModel(turns: Turn[]): ChatModel {
  let index = 0;
  return {
    ref: 'fake/model',
    provider: 'fake',
    providerLabel: 'Fake',
    id: 'model',
    name: 'Fake',
    capabilities: { tools: true, jsonSchema: false },
    chat(_messages, options) {
      const turn = turns[index++];
      if (typeof turn === 'function') return turn(options?.signal ?? new AbortController().signal);
      return (async function* () {
        yield* turn;
      })();
    },
  };
}

const resolverFor = (model: ChatModel): ModelResolver => ({ resolve: async () => model });

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
}

function request(overrides: Partial<AgentRequest['agent']> = {}): AgentRequest {
  return {
    stepId: 'try-it',
    agent: {
      name: 'A',
      model: 'fake/model',
      tools: ['readFile'],
      permissions: { edits: 'ask' },
      ...overrides,
    },
    prompt: 'Hi',
    history: [],
    output: undefined,
    contextFiles: [],
  };
}

describe('TryItSession', () => {
  it('streams text and tool lines, then reports usage and model', async () => {
    const model = fakeModel([
      [
        { type: 'text', text: 'Let me look. ' },
        { type: 'tool-call', call: { id: 'c1', name: 'readFile', arguments: '{"path":"src/a.ts"}' } },
        { type: 'usage', inputTokens: 10, outputTokens: 2 },
        { type: 'done', finishReason: 'tool-calls' },
      ],
      [
        { type: 'text', text: 'Looks ' },
        { type: 'text', text: 'good.' },
        { type: 'usage', inputTokens: 20, outputTokens: 3 },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const calls: { path: unknown; permissions: AgentPermissions; runId: string }[] = [];
    const tools = (runId: string): ToolHost => ({
      execute: async (call, _io, permissions) => {
        calls.push({ path: call.args.path, permissions, runId });
        return { content: 'line 1\nline 2' };
      },
    });
    const events: TryItEvent[] = [];
    const session = new TryItSession({ resolver: resolverFor(model), tools, now: () => 42 }, (e) =>
      events.push(e),
    );

    await session.start(request());

    expect(events).toEqual([
      { type: 'text', text: 'Let me look. ' },
      { type: 'tool', name: 'readFile', args: 'src/a.ts', result: '2 lines' },
      { type: 'text', text: 'Looks ' },
      { type: 'text', text: 'good.' },
      { type: 'done', usage: { inputTokens: 30, outputTokens: 5 }, model: 'fake/model' },
    ]);
    expect(calls).toEqual([{ path: 'src/a.ts', permissions: { edits: 'ask' }, runId: 'try-42' }]);
    expect(session.running).toBe(false);
  });

  it('reports model errors', async () => {
    const resolver: ModelResolver = {
      resolve: async () => {
        throw new Error('Provider litellm is not configured.');
      },
    };
    const events: TryItEvent[] = [];
    const session = new TryItSession(
      { resolver, tools: () => ({ execute: async () => ({ content: '' }) }) },
      (e) => events.push(e),
    );
    await session.start(request());
    expect(events).toEqual([{ type: 'error', message: 'Provider litellm is not configured.' }]);
  });

  it('stops on cancel', async () => {
    const model = fakeModel([
      (signal) =>
        (async function* () {
          yield { type: 'text', text: 'Thinking' } as const;
          await waitForAbort(signal);
        })(),
    ]);
    const events: TryItEvent[] = [];
    const session = new TryItSession(
      { resolver: resolverFor(model), tools: () => ({ execute: async () => ({ content: '' }) }) },
      (e) => events.push(e),
    );
    const done = session.start(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.running).toBe(true);
    session.cancel();
    await done;
    expect(events).toEqual([
      { type: 'text', text: 'Thinking' },
      { type: 'error', message: 'Stopped.' },
    ]);
    expect(session.running).toBe(false);
  });

  it('runs one try at a time: a new try silently replaces the running one', async () => {
    const model = fakeModel([
      (signal) =>
        (async function* () {
          yield { type: 'text', text: 'first' } as const;
          await waitForAbort(signal);
        })(),
      [
        { type: 'text', text: 'second' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const events: TryItEvent[] = [];
    const session = new TryItSession(
      { resolver: resolverFor(model), tools: () => ({ execute: async () => ({ content: '' }) }) },
      (e) => events.push(e),
    );
    const first = session.start(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.start(request());
    await first;
    expect(events).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'done', usage: { inputTokens: 0, outputTokens: 0 }, model: 'fake/model' },
    ]);
  });

  it('emits nothing after dispose', async () => {
    const model = fakeModel([
      (signal) => ({ [Symbol.asyncIterator]: () => ({ next: () => waitForAbort(signal) }) }),
    ]);
    const events: TryItEvent[] = [];
    const session = new TryItSession(
      { resolver: resolverFor(model), tools: () => ({ execute: async () => ({ content: '' }) }) },
      (e) => events.push(e),
    );
    const done = session.start(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.dispose();
    await done;
    expect(events).toEqual([]);
  });
});
