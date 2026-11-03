import { describe, expect, it } from 'vitest';
import { type AgentLoopOptions, runAgentLoop, toolSpecsFor } from '../../src/agent';
import { textToolSection } from '../../src/agent/textTools';
import type { ChatMessage, ModelCapabilities } from '../../src/models/types';
import { callTools, FakeModel, type FakeTurn, say, textCall } from '../fakes/fakeModel';
import { FakeToolHost, recordingIO } from './helpers';

const NO_NATIVE_TOOLS: Partial<ModelCapabilities> = { tools: false };
const TEXT_MODE_LINE =
  'fake/model has no native tool calling, so the tools are described in the prompt (text tool mode).\n';
const REPAIR_LINE = 'The model wrote a tool call as text; running it.\n';
const UNREADABLE_TWICE =
  'The model wrote tool calls that could not be read twice. In the agent, set Tool calls to Text in the prompt, or use a model with native tool calling.';

function setup(
  turns: FakeTurn[],
  overrides: Partial<AgentLoopOptions> = {},
  capabilities: Partial<ModelCapabilities> = {},
) {
  const host = new FakeToolHost({
    readFile: (call) => ({ content: `content of ${String(call.args.path)}` }),
    listFiles: () => ({ content: 'a.ts\nb.ts' }),
    gitDiff: () => ({ content: 'diff --git a b' }),
  });
  const io = recordingIO();
  const model = new FakeModel(turns, { capabilities });
  const options: AgentLoopOptions = {
    model,
    systemPrompt: 'You are careful.',
    prompt: 'Fix the bug.',
    tools: ['readFile', 'listFiles', 'gitDiff'],
    toolHost: host,
    permissions: { edits: 'none', commands: 'none' },
    io,
    ...overrides,
  };
  return { model, host, io, options };
}

const roles = (messages: ChatMessage[]) => messages.map((m) => m.role);

describe('runAgentLoop: tool-call repair in auto mode', () => {
  it('runs a tool call written as text and keeps the prose', async () => {
    const { model, host, io, options } = setup([
      say(`I will read it.\n${textCall('readFile', { path: 'src/app.ts' })}`),
      say('The bug is fixed.'),
    ]);

    const result = await runAgentLoop(options);

    expect(result.text).toBe('The bug is fixed.');
    expect(result.toolCalls).toBe(1);
    expect(host.calls.map((c) => c.call)).toEqual([{ name: 'readFile', args: { path: 'src/app.ts' } }]);
    expect(model.calls[0].options.tools).toEqual(toolSpecsFor(['readFile', 'listFiles', 'gitDiff']));
    expect(result.messages.slice(1, 3)).toEqual([
      {
        role: 'assistant',
        content: 'I will read it.',
        toolCalls: [{ id: 'call_1', name: 'readFile', arguments: '{"path":"src/app.ts"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'readFile', content: 'content of src/app.ts' },
    ]);
    expect(model.calls[1].messages.slice(2, 4)).toEqual(result.messages.slice(1, 3));
    expect(io.textOf('info')).toBe(REPAIR_LINE);
    expect(io.textOf('tool')).toBe('readFile src/app.ts → content of src/app.ts\n');
  });

  it('logs the repair once per block and numbers the calls', async () => {
    const { io, options } = setup([
      say(textCall('readFile', { path: 'a.ts' })),
      say(`${textCall('readFile', { path: 'b.ts' })}${textCall('gitDiff')}`),
      say('ok'),
    ]);
    const result = await runAgentLoop(options);
    expect(io.textOf('info')).toBe(REPAIR_LINE);
    expect(result.toolCalls).toBe(3);
    const ids = result.messages.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : []));
    expect(ids).toEqual(['call_1', 'call_2', 'call_3']);
  });

  it('prefers native calls and keeps the text when a reply has both', async () => {
    const text = `Reading. ${textCall('readFile', { path: 'x.ts' })}`;
    const { host, options } = setup([
      { text, toolCalls: [{ id: 'n1', name: 'listFiles', args: {} }] },
      say('ok'),
    ]);
    const result = await runAgentLoop(options);
    expect(host.calls.map((c) => c.call.name)).toEqual(['listFiles']);
    expect(result.messages[1]).toMatchObject({ role: 'assistant', content: text });
    expect(result.toolCalls).toBe(1);
  });

  it('treats tool calls for unknown tools as the answer', async () => {
    const answer = `Done. ${textCall('deleteRepo', { force: true })}`;
    const { host, options } = setup([say(answer)]);
    const result = await runAgentLoop(options);
    expect(result.text).toBe(answer);
    expect(host.calls).toHaveLength(0);
    expect(result.toolCalls).toBe(0);
  });

  it('does not look for text calls when the agent has no tools', async () => {
    const answer = textCall('readFile', { path: 'a' });
    const { host, options } = setup([say(answer)], { tools: [] });
    expect((await runAgentLoop(options)).text).toBe(answer);
    expect(host.calls).toHaveLength(0);
  });

  it('counts the repaired turn against maxTurns like a native one', async () => {
    const { options } = setup([say(textCall('gitDiff')), say(textCall('gitDiff'))], { maxTurns: 2 });
    await expect(runAgentLoop(options)).rejects.toThrow(/all 2 turns/);
  });
});

describe('runAgentLoop: native tool mode', () => {
  it('sends native tools and treats text calls as the answer', async () => {
    const answer = textCall('readFile', { path: 'a.ts' });
    const { model, host, io, options } = setup([say(answer)], { toolMode: 'native' }, NO_NATIVE_TOOLS);
    const result = await runAgentLoop(options);
    expect(result.text).toBe(answer);
    expect(host.calls).toHaveLength(0);
    expect(model.calls[0].options.tools).toEqual(toolSpecsFor(['readFile', 'listFiles', 'gitDiff']));
    expect(model.calls[0].messages[0]).toEqual({ role: 'system', content: 'You are careful.' });
    expect(io.textOf('info')).toBe('');
  });
});

describe('runAgentLoop: text tool mode', () => {
  it('describes the tools in the system prompt and sends results as user messages', async () => {
    const { model, host, io, options } = setup(
      [
        say(`Let me check.\n${textCall('readFile', { path: 'a.ts' })}${textCall('gitDiff')}`),
        say('All good.'),
      ],
      {},
      NO_NATIVE_TOOLS,
    );

    const result = await runAgentLoop(options);

    expect(result.text).toBe('All good.');
    expect(host.calls.map((c) => c.call.name)).toEqual(['readFile', 'gitDiff']);
    const specs = toolSpecsFor(['readFile', 'listFiles', 'gitDiff']);
    for (const call of model.calls) {
      expect(call.options.tools).toBeUndefined();
      expect(call.messages[0]).toEqual({
        role: 'system',
        content: `You are careful.\n\n${textToolSection(specs)}`,
      });
    }
    expect(model.calls[1].messages.slice(1)).toEqual([
      { role: 'user', content: 'Fix the bug.' },
      {
        role: 'assistant',
        content:
          'Let me check.\n\n' +
          '<tool_call>{"name": "readFile", "arguments": {"path": "a.ts"}}</tool_call>\n' +
          '<tool_call>{"name": "gitDiff", "arguments": {}}</tool_call>',
      },
      {
        role: 'user',
        content:
          'Result of readFile (call_1):\ncontent of a.ts\n\nResult of gitDiff (call_2):\ndiff --git a b',
      },
    ]);
    expect(roles(result.messages)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [
        { id: 'call_1', name: 'readFile', arguments: '{"path":"a.ts"}' },
        { id: 'call_2', name: 'gitDiff', arguments: '{}' },
      ],
    });
    expect(io.textOf('info')).toBe(TEXT_MODE_LINE);
    expect(result.toolCalls).toBe(2);
  });

  it('is used when chosen, even for models with native tool calling', async () => {
    const { model, io, options } = setup([say(textCall('listFiles')), say('ok')], { toolMode: 'text' });
    const result = await runAgentLoop(options);
    expect(model.calls[0].options.tools).toBeUndefined();
    expect(model.calls[0].messages[0].content).toContain('<tool_call>');
    expect(result.toolCalls).toBe(1);
    expect(io.textOf('info')).toBe('');
  });

  it('uses only the tool section as system prompt when the agent has none', async () => {
    const { model, options } = setup([say('ok')], { systemPrompt: undefined, toolMode: 'text' });
    await runAgentLoop(options);
    expect(model.calls[0].messages[0]).toEqual({
      role: 'system',
      content: textToolSection(toolSpecsFor(['readFile', 'listFiles', 'gitDiff'])),
    });
  });

  it('stays in plain mode without tools', async () => {
    const { model, io, options } = setup([say('ok')], { tools: [] }, NO_NATIVE_TOOLS);
    await runAgentLoop(options);
    expect(model.calls[0].messages[0]).toEqual({ role: 'system', content: 'You are careful.' });
    expect(io.textOf('info')).toBe('');
  });

  it('does not constrain the answer to the JSON schema while tools are offered as text', async () => {
    const output = { format: 'json' as const, schema: { approved: 'boolean' } };
    const { model, options } = setup(
      [say(textCall('gitDiff')), say('{"approved": true}')],
      { output, toolMode: 'text' },
      { jsonSchema: true },
    );
    const result = await runAgentLoop(options);
    expect(result.json).toEqual({ approved: true });
    expect(model.calls[0].options.jsonSchema).toBeUndefined();
  });
});

describe('runAgentLoop: unreadable tool calls', () => {
  const broken = "<tool_call>{'name': 'readFile', 'arguments': {'path': 'a.ts'}}</tool_call>";

  it('asks once for a corrected call and then runs it', async () => {
    const { model, host, io, options } = setup([
      say(broken, { inputTokens: 5, outputTokens: 1 }),
      say(textCall('readFile', { path: 'a.ts' })),
      say('Fixed.'),
    ]);

    const result = await runAgentLoop(options);

    expect(result.text).toBe('Fixed.');
    expect(result.turns).toBe(3);
    expect(host.calls).toHaveLength(1);
    const corrective = model.calls[1].messages.slice(2);
    expect(corrective[0]).toEqual({ role: 'assistant', content: broken });
    expect(corrective[1].role).toBe('user');
    expect(corrective[1].content).toMatch(
      /^Your tool call could not be read: the call of readFile is not valid JSON \(.+\)\. Reply with only the tool call, as <tool_call>\{"name": "readFile", "arguments": \{"path": "…"\}\}<\/tool_call>\.$/,
    );
    expect(io.textOf('info')).toContain(
      'The model wrote a tool call that could not be read; asking it to correct it.\n',
    );
    expect(result.toolCalls).toBe(1);
  });

  it('fails the block after a second unreadable reply in a row', async () => {
    const { model, host, options } = setup([
      say(broken, { inputTokens: 1, outputTokens: 1 }),
      say('<tool_call>{"name": "readFile", "arguments": "a.ts"}</tool_call>'),
      say('unused'),
    ]);
    await expect(runAgentLoop(options)).rejects.toThrow(UNREADABLE_TWICE);
    expect(model.calls).toHaveLength(2);
    expect(host.calls).toHaveLength(0);
  });

  it('allows another correction after a readable reply', async () => {
    const { model, options } = setup([
      say(broken),
      say(textCall('readFile', { path: 'a.ts' })),
      say(broken),
      say(textCall('readFile', { path: 'b.ts' })),
      say('done'),
    ]);
    const result = await runAgentLoop(options);
    expect(result.text).toBe('done');
    expect(model.calls).toHaveLength(5);
    expect(result.toolCalls).toBe(2);
  });

  it('does not count corrective rounds against maxTurns', async () => {
    const { options } = setup([say(broken), say(textCall('gitDiff')), say('done')], { maxTurns: 2 });
    expect((await runAgentLoop(options)).text).toBe('done');
  });

  it('shows an empty arguments object for tools without required parameters', async () => {
    const { model, options } = setup([
      say('<tool_call>{"name": "gitDiff", "arguments": [true]}</tool_call>'),
      say('done'),
    ]);
    await runAgentLoop(options);
    expect(model.calls[1].messages[3].content).toBe(
      'Your tool call could not be read: the arguments of gitDiff are not a JSON object. ' +
        'Reply with only the tool call, as <tool_call>{"name": "gitDiff", "arguments": {}}</tool_call>.',
    );
  });

  it('runs nothing from a reply that also holds an unreadable call', async () => {
    const { host, options } = setup([
      say(`${textCall('listFiles')}${broken}`),
      say(textCall('listFiles')),
      say('done'),
    ]);
    await runAgentLoop(options);
    expect(host.calls).toHaveLength(1);
  });
});

describe('runAgentLoop: JSON answers and text calls', () => {
  const output = { format: 'json' as const, schema: { name: 'string', arguments: 'object' } };

  it('reads an answer that is exactly a call of an enabled tool as a call', async () => {
    const { host, options } = setup(
      [
        say('{"name": "readFile", "arguments": {"path": "a.ts"}}'),
        say('{"name": "Ada", "arguments": {"born": 1815}}'),
      ],
      { output },
    );
    const result = await runAgentLoop(options);
    expect(host.calls).toHaveLength(1);
    expect(result.json).toEqual({ name: 'Ada', arguments: { born: 1815 } });
  });

  it('keeps a JSON answer that mentions a tool call in prose', async () => {
    const answer = 'Result: {"name": "readFile", "arguments": {"path": "a.ts"}}';
    const { host, options } = setup([say(answer)], { output });
    const result = await runAgentLoop(options);
    expect(host.calls).toHaveLength(0);
    expect(result.json).toEqual({ name: 'readFile', arguments: { path: 'a.ts' } });
  });

  it('runs a tool call during the JSON repair round', async () => {
    const reviewOutput = { format: 'json' as const, schema: { approved: 'boolean' } };
    const { host, options } = setup(
      [say('Looks fine.'), say(textCall('gitDiff')), say('{"approved": true}')],
      { output: reviewOutput, maxTurns: 1 },
    );
    await expect(runAgentLoop(options)).rejects.toThrow(/all 1 turns/);
    expect(host.calls).toHaveLength(0);

    const roomy = setup([say('Looks fine.'), say(textCall('gitDiff')), say('{"approved": true}')], {
      output: reviewOutput,
    });
    expect((await runAgentLoop(roomy.options)).json).toEqual({ approved: true });
    expect(roomy.host.calls).toHaveLength(1);
  });
});

describe('runAgentLoop: tool call counting', () => {
  it('counts native, refused, failed and repaired calls', async () => {
    const { options } = setup([
      callTools(
        { name: 'readFile', args: { path: 'a.ts' } },
        { name: 'runCommand', args: { command: 'npm test' } },
        { name: 'readFile', args: '{"path":' },
      ),
      say(textCall('listFiles')),
      say('done'),
    ]);
    const result = await runAgentLoop(options);
    expect(result.toolCalls).toBe(4);
  });

  it('reports zero for answers without tools', async () => {
    const { options } = setup([say('done')]);
    expect((await runAgentLoop(options)).toolCalls).toBe(0);
  });
});
