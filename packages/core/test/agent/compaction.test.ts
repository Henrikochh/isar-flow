import { describe, expect, it } from 'vitest';
import {
  type AgentLoopOptions,
  estimateTokens,
  executeAgentRequest,
  runAgentLoop,
  toolSpecsFor,
} from '../../src/agent';
import { type ChatMessage, type ChatModel, ModelError } from '../../src/models/types';
import { callTools, FakeModel, type FakeTurn, say } from '../fakes/fakeModel';
import { FakeToolHost, type RecordingIO, recordingIO } from './helpers';

const SUMMARY_PREFIX = 'Summary of the earlier work (older messages were removed to save context):\n';
const big = (label: string, size: number) => `${label}:${'x'.repeat(size - label.length - 1)}`;
const read = (path: string): FakeTurn => callTools({ id: `id_${path}`, name: 'readFile', args: { path } });

interface Sizes {
  /** Length of every readFile result (default 3000). */
  size?: number;
  /** Lengths for single paths. */
  sizes?: Record<string, number>;
  maxInputTokens?: number;
}

/** A loop whose readFile results are `size` characters long; contextTokens 2000 compacts above 1400 tokens. */
function setup(
  turns: FakeTurn[],
  overrides: Partial<AgentLoopOptions> = {},
  sizes: Sizes = {},
  io = recordingIO(),
) {
  const host = new FakeToolHost({
    readFile: (call) => {
      const path = String(call.args.path);
      return { content: big(path, sizes.sizes?.[path] ?? sizes.size ?? 3000) };
    },
  });
  const model = new FakeModel(turns, { maxInputTokens: sizes.maxInputTokens });
  const options: AgentLoopOptions = {
    model,
    systemPrompt: 'You are careful.',
    prompt: 'Fix the bug.',
    tools: ['readFile'],
    toolHost: host,
    permissions: {},
    contextTokens: 2000,
    io,
    ...overrides,
  };
  return { model, host, io, options };
}

function infoLines(io: RecordingIO): string[] {
  return io.textOf('info').split('\n').filter(Boolean);
}

function expectIntactPairs(messages: ChatMessage[]) {
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    const owner = messages.slice(0, index).findLast((m) => m.role === 'assistant');
    const ids = owner?.role === 'assistant' ? (owner.toolCalls ?? []).map((c) => c.id) : [];
    expect(ids).toContain(message.toolCallId);
  });
}

const WARNING_TAIL =
  'The system prompt, the task and the latest tool results are always kept in full. ' +
  'Attach fewer or smaller context files, or use a model with a larger context.';

describe('estimateTokens', () => {
  it('counts a quarter token per character of prompt, messages, call arguments and tools', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'abcd' },
      {
        role: 'assistant',
        content: 'ab',
        toolCalls: [{ id: 'c', name: 'readFile', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'c', name: 'readFile', content: 'abcdefgh' },
    ];
    expect(estimateTokens({ messages })).toBe(Math.ceil((4 + 2 + 12 + 8) / 4));
    expect(estimateTokens({ system: 'abc', messages: [] })).toBe(1);
    const tools = toolSpecsFor(['readFile']);
    expect(estimateTokens({ messages: [], tools })).toBe(Math.ceil(JSON.stringify(tools).length / 4));
    expect(estimateTokens({ messages: [] })).toBe(0);
  });
});

describe('runAgentLoop: compaction', () => {
  it('replaces the older turns with a summary and keeps the task and the latest exchange', async () => {
    const { model, io, options } = setup([
      read('a.ts'),
      read('b.ts'),
      say('Read a.ts; it is long.', { inputTokens: 100, outputTokens: 10 }),
      say('Fixed.', { inputTokens: 5, outputTokens: 1 }),
    ]);

    const result = await runAgentLoop(options);

    expect(result.text).toBe('Fixed.');
    expect(result.turns).toBe(3);
    expect(result.usage).toEqual({ inputTokens: 105, outputTokens: 11 });
    expect(model.calls).toHaveLength(4);

    const summaryRequest = model.calls[2];
    expect(summaryRequest.options).toMatchObject({ temperature: 0, maxTokens: 1024, signal: io.signal });
    expect(summaryRequest.options.tools).toBeUndefined();
    expect(summaryRequest.messages).toHaveLength(1);
    const prompt = summaryRequest.messages[0].content;
    expect(prompt).toMatch(/file paths, decisions, findings, errors and open work/);
    expect(prompt).toMatch(/at most 300 words/);
    expect(prompt).toContain('Fix the bug.');
    expect(prompt).toContain('Tool call: readFile {"path":"a.ts"}');
    expect(prompt).toContain(`Result of readFile (id_a.ts):\na.ts:${'x'.repeat(1995)}`);
    expect(prompt).not.toContain('x'.repeat(2001));
    expect(prompt).not.toContain('b.ts:');

    const last = model.calls[3].messages;
    expect(last).toEqual([
      { role: 'system', content: 'You are careful.' },
      { role: 'user', content: 'Fix the bug.' },
      { role: 'user', content: `${SUMMARY_PREFIX}Read a.ts; it is long.` },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'id_b.ts', name: 'readFile', arguments: '{"path":"b.ts"}' }],
      },
      { role: 'tool', toolCallId: 'id_b.ts', name: 'readFile', content: big('b.ts', 3000) },
    ]);
    expect(result.messages).toEqual([...last.slice(1), { role: 'assistant', content: 'Fixed.' }]);
    expect(infoLines(io)).toEqual([
      'Compacted the conversation: 2 older messages (about 750 tokens) replaced by a summary (about 6 tokens).',
    ]);
  });

  it('does not compact below 70 % of the context', async () => {
    const { model, io, options } = setup([read('a.ts'), read('b.ts'), say('Fixed.')], {}, { size: 2000 });
    await runAgentLoop(options);
    expect(model.calls).toHaveLength(3);
    expect(io.textOf('info')).toBe('');
  });

  it('prefers the context size the model reports', async () => {
    const small = setup(
      [read('a.ts'), read('b.ts'), say('S'), say('Fixed.')],
      { contextTokens: 100_000 },
      {
        maxInputTokens: 2000,
      },
    );
    await runAgentLoop(small.options);
    expect(small.model.calls).toHaveLength(4);

    const large = setup(
      [read('a.ts'), read('b.ts'), say('Fixed.')],
      { contextTokens: 2000 },
      {
        maxInputTokens: 100_000,
      },
    );
    await runAgentLoop(large.options);
    expect(large.model.calls).toHaveLength(3);
  });

  it('uses 24,000 tokens when neither the model nor the settings give a size', async () => {
    const below = setup(
      [read('a.ts'), read('b.ts'), say('Fixed.')],
      { contextTokens: undefined },
      { size: 30_000 },
    );
    await runAgentLoop(below.options);
    expect(below.model.calls).toHaveLength(3);

    const above = setup(
      [read('a.ts'), read('b.ts'), say('S'), say('Fixed.')],
      { contextTokens: undefined },
      {
        size: 36_000,
      },
    );
    await runAgentLoop(above.options);
    expect(above.model.calls).toHaveLength(4);
  });

  it('counts the tool specs of native requests', async () => {
    const toolChars = JSON.stringify(toolSpecsFor(['readFile'])).length;
    const callChars = '{"path":"a.ts"}'.length;
    // Two results end just below the threshold (5,600 characters) without the specs and above it with them.
    const size = Math.floor((5600 - 2 * callChars - toolChars / 2) / 2);
    const { model, options } = setup(
      [read('a.ts'), read('b.ts'), say('S'), say('Fixed.')],
      {
        systemPrompt: undefined,
        prompt: '',
      },
      { size },
    );
    await runAgentLoop(options);
    expect(model.calls).toHaveLength(4);
  });

  it('never separates tool calls from their results', async () => {
    const turns: FakeTurn[] = [
      callTools(
        { id: 'p', name: 'readFile', args: { path: 'p.ts' } },
        { id: 'q', name: 'readFile', args: { path: 'q.ts' } },
      ),
      callTools(
        { id: 'r', name: 'readFile', args: { path: 'r.ts' } },
        { id: 's', name: 'readFile', args: { path: 's.ts' } },
      ),
      say('Summary.'),
      say('Fixed.'),
    ];
    const { model, options } = setup(turns, {}, { size: 1500 });
    const result = await runAgentLoop(options);
    const last = model.calls[3].messages;
    expect(last.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'tool']);
    expectIntactPairs(last);
    expectIntactPairs(result.messages);
  });

  it('keeps the JSON instructions of the task verbatim', async () => {
    const output = { format: 'json' as const, schema: { fixed: 'boolean' } };
    const { model, options } = setup([read('a.ts'), read('b.ts'), say('S'), say('{"fixed": true}')], {
      output,
    });
    const result = await runAgentLoop(options);
    expect(result.json).toEqual({ fixed: true });
    expect(model.calls[3].messages[1]).toEqual(model.calls[0].messages[1]);
    expect(model.calls[3].messages[1].content).toMatch(/JSON only/);
  });

  it('summarizes a long session history before the first turn', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: big('old task', 3000) },
      { role: 'assistant', content: big('old answer', 3000) },
    ];
    const { model, options } = setup([say('Earlier: fixed a.ts.'), say('Done.')], {
      history,
      prompt: big('new task', 2000),
    });
    const result = await runAgentLoop(options);
    expect(model.calls[0].messages[0].content).toContain('User:\nold task:');
    expect(model.calls[1].messages.slice(1)).toEqual([
      { role: 'user', content: `${SUMMARY_PREFIX}Earlier: fixed a.ts.` },
      { role: 'user', content: big('new task', 2000) },
    ]);
    expect(result.messages).toHaveLength(3);
  });

  it('folds an earlier summary into the next one', async () => {
    const { model, options } = setup([
      read('a.ts'),
      read('b.ts'),
      say('First.'),
      read('c.ts'),
      say('Second.'),
      say('Done.'),
    ]);
    const result = await runAgentLoop(options);
    expect(model.calls).toHaveLength(6);
    expect(model.calls[4].messages[0].content).toContain('First.');
    expect(result.messages.filter((m) => m.content.startsWith(SUMMARY_PREFIX))).toHaveLength(1);
    expect(result.messages[1].content).toBe(`${SUMMARY_PREFIX}Second.`);
  });

  it('keeps a repair request together with the answer it is about', async () => {
    const output = { format: 'json' as const, schema: { fixed: 'boolean' } };
    const { model, io, options } = setup([say(big('not json', 7000)), say('{"fixed": true}')], { output });
    const result = await runAgentLoop(options);
    expect(result.json).toEqual({ fixed: true });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(infoLines(io)[1]).toMatch(/^The conversation still needs about/);
  });

  it('strips reasoning from the summary', async () => {
    const { model, options } = setup([
      read('a.ts'),
      read('b.ts'),
      say('<think>hmm</think>\nRead a.ts.'),
      say('Fixed.'),
    ]);
    await runAgentLoop(options);
    expect(model.calls[3].messages[2].content).toBe(`${SUMMARY_PREFIX}Read a.ts.`);
  });

  it('continues with the full conversation when the summary fails and does not retry', async () => {
    const { model, io, options } = setup([
      read('a.ts'),
      read('b.ts'),
      { error: new ModelError('Server error 503.', 'server', 503) },
      read('c.ts'),
      say('Fixed.'),
    ]);
    const result = await runAgentLoop(options);
    expect(result.text).toBe('Fixed.');
    expect(model.calls[3].messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(model.calls).toHaveLength(5);
    expect(infoLines(io)).toEqual([
      'Could not compact the conversation: Server error 503. Continuing with the full conversation.',
    ]);
  });

  it('lets a fallback model compact after the summary of the main model failed', async () => {
    const host = new FakeToolHost({ readFile: (call) => ({ content: big(String(call.args.path), 3000) }) });
    const main = new FakeModel(
      [
        read('a.ts'),
        read('b.ts'),
        { error: new ModelError('Server error 503.', 'server', 503) },
        { error: new ModelError('Too many requests.', 'rate-limit', 429) },
      ],
      { ref: 'main/model' },
    );
    const fallback = new FakeModel([say('Read a.ts.'), say('Fixed.')], { ref: 'backup/model' });
    const models: Record<string, ChatModel> = { 'main/model': main, 'backup/model': fallback };
    const io = recordingIO();

    const result = await executeAgentRequest(
      {
        stepId: 'fix',
        agent: { name: 'Coder', model: 'main/model', tools: ['readFile'], fallbackModels: ['backup/model'] },
        prompt: 'Fix the bug.',
        history: [],
        contextFiles: [],
      },
      { resolver: { resolve: async (ref) => models[ref] }, io, toolHost: host, contextTokens: 2000 },
    );

    expect(result).toMatchObject({ text: 'Fixed.', model: 'backup/model' });
    expect(fallback.calls[0].options.maxTokens).toBe(1024);
    expect(fallback.calls[1].messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'tool']);
    expect(fallback.calls[1].messages[1].content).toBe(`${SUMMARY_PREFIX}Read a.ts.`);
    expect(infoLines(io)).toEqual([
      'Could not compact the conversation: Server error 503. Continuing with the full conversation.',
      'Model main/model failed: Too many requests. Trying fallback model backup/model.',
      'Compacted the conversation: 2 older messages (about 750 tokens) replaced by a summary (about 3 tokens).',
    ]);
  });

  it('treats an empty summary as a failure', async () => {
    const { io, options } = setup([read('a.ts'), read('b.ts'), say(''), say('Fixed.')]);
    await runAgentLoop(options);
    expect(infoLines(io)).toEqual([
      'Could not compact the conversation: the model returned an empty summary. Continuing with the full conversation.',
    ]);
  });

  it('rethrows a cancel during the summary request', async () => {
    const io = recordingIO();
    const { model, options } = setup(
      [
        read('a.ts'),
        read('b.ts'),
        { text: ['Sum', 'mary'], onStream: () => io.controller.abort() },
        say('never'),
      ],
      {},
      {},
      io,
    );
    await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.calls).toHaveLength(3);
    expect(io.textOf('info')).toBe('');
  });

  it('warns once when the conversation cannot be made small enough', async () => {
    const { model, io, options } = setup([read('a.ts'), say('Fixed.')], { systemPrompt: big('rules', 8000) });
    await runAgentLoop(options);
    expect(model.calls).toHaveLength(2);
    const lines = infoLines(io);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^The conversation still needs about 2,\d00 tokens, more than 70 % of the 2,000-token context\. /,
    );
    expect(lines[0]).toContain(WARNING_TAIL);
    expect(lines[0]).toMatch(/ If the model supports more, raise isarFlow\.agentContextTokens\.$/);
  });

  it('does not suggest the setting when the model reports its context size', async () => {
    const { io, options } = setup([say('Fixed.')], { prompt: big('task', 8000) }, { maxInputTokens: 1000 });
    await runAgentLoop(options);
    const lines = infoLines(io);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/1,000-token context\. /);
    expect(lines[0].endsWith(WARNING_TAIL)).toBe(true);
  });

  it('warns after compacting when the kept parts are still too large', async () => {
    const { model, io, options } = setup(
      [read('a.ts'), read('b.ts'), say('S'), say('Fixed.')],
      {},
      {
        sizes: { 'b.ts': 6000 },
      },
    );
    await runAgentLoop(options);
    expect(model.calls).toHaveLength(4);
    const lines = infoLines(io);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Compacted the conversation: 2 older messages/);
    expect(lines[1]).toMatch(/^The conversation still needs about 1,\d00 tokens/);
  });
});
