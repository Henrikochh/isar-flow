import { describe, expect, it } from 'vitest';
import { type AgentLoopOptions, runAgentLoop, toolSpecsFor } from '../../src/agent';
import { type ChatMessage, ModelError } from '../../src/models/types';
import { callTools, FakeModel, type FakeTurn, say } from '../fakes/fakeModel';
import { FakeToolHost, type RecordingIO, recordingIO } from './helpers';

function setup(
  turns: FakeTurn[],
  overrides: Partial<AgentLoopOptions> = {},
  capabilities = {},
  io: RecordingIO = recordingIO(),
) {
  const model = new FakeModel(turns, { capabilities });
  const options: AgentLoopOptions = {
    model,
    prompt: 'Review the change.',
    tools: [],
    permissions: { edits: 'none', commands: 'none' },
    io,
    ...overrides,
  };
  return { model, io, options };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

function toolMessages(messages: ChatMessage[]) {
  return messages.filter((m) => m.role === 'tool');
}

describe('runAgentLoop: plain answers', () => {
  it('streams text to the agent log and returns the final answer', async () => {
    const { model, io, options } = setup([say(['Looks ', 'good.'], { inputTokens: 10, outputTokens: 3 })], {
      systemPrompt: 'You are a reviewer.',
      temperature: 0.2,
      maxTokens: 500,
    });

    const result = await runAgentLoop(options);

    expect(result).toEqual({
      text: 'Looks good.',
      usage: { inputTokens: 10, outputTokens: 3 },
      turns: 1,
      model: 'fake/model',
      messages: [
        { role: 'user', content: 'Review the change.' },
        { role: 'assistant', content: 'Looks good.' },
      ],
    });
    expect(io.logs.filter((l) => l.stream === 'agent').map((l) => l.text)).toEqual(['Looks ', 'good.']);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].messages).toEqual([
      { role: 'system', content: 'You are a reviewer.' },
      { role: 'user', content: 'Review the change.' },
    ]);
    const sent = model.calls[0].options;
    expect(sent.tools).toBeUndefined();
    expect(sent.jsonSchema).toBeUndefined();
    expect(sent.temperature).toBe(0.2);
    expect(sent.maxTokens).toBe(500);
    expect(sent.signal).toBe(io.signal);
  });

  it('passes history through and returns the whole conversation without the system prompt', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'First task' },
      { role: 'assistant', content: 'First answer' },
    ];
    const { model, options } = setup([say('Second answer')], { systemPrompt: 'System', history });

    const result = await runAgentLoop(options);

    expect(model.calls[0].messages).toEqual([
      { role: 'system', content: 'System' },
      ...history,
      { role: 'user', content: 'Review the change.' },
    ]);
    expect(result.messages).toEqual([
      ...history,
      { role: 'user', content: 'Review the change.' },
      { role: 'assistant', content: 'Second answer' },
    ]);
    expect(history).toHaveLength(2);
  });

  it('passes tool calls and results from the history through unchanged', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'Fix it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'readFile', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 't1', name: 'readFile', content: 'text', isError: true },
      { role: 'assistant', content: 'Fixed' },
    ];
    const { model, options } = setup([say('Again')], { history });
    const result = await runAgentLoop(options);
    expect(model.calls[0].messages.slice(0, 4)).toEqual(history);
    expect(result.messages.slice(0, 4)).toEqual(history);
  });

  it('drops system messages that slipped into the history', async () => {
    const history: ChatMessage[] = [{ role: 'system', content: 'Old system' }];
    const { model, options } = setup([say('ok')], { systemPrompt: 'New system', history });
    await runAgentLoop(options);
    expect(model.calls[0].messages.filter((m) => m.role === 'system')).toEqual([
      { role: 'system', content: 'New system' },
    ]);
  });

  it('logs a hint when the answer was cut off by maxTokens', async () => {
    const { io, options } = setup([{ text: 'Partial', finishReason: 'length' }]);
    await runAgentLoop(options);
    expect(io.textOf('info')).toMatch(/maxTokens/);
  });

  it('propagates model errors', async () => {
    const { options } = setup([{ error: new ModelError('Invalid API key for litellm.', 'auth', 401) }]);
    await expect(runAgentLoop(options)).rejects.toThrow('Invalid API key for litellm.');
  });
});

describe('runAgentLoop: tools', () => {
  it('runs a tool call and feeds the result back before the final answer', async () => {
    const host = new FakeToolHost({ readFile: () => ({ content: lines(120) }) });
    const { model, io, options } = setup(
      [
        {
          toolCalls: [{ id: 'c1', name: 'readFile', args: { path: 'src/app.ts' } }],
          usage: { inputTokens: 5, outputTokens: 2 },
        },
        say('The file looks fine.', { inputTokens: 7, outputTokens: 4 }),
      ],
      { tools: ['readFile', 'searchText'], toolHost: host, permissions: { edits: 'ask' } },
    );

    const result = await runAgentLoop(options);

    expect(result.text).toBe('The file looks fine.');
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
    expect(host.calls).toEqual([
      { call: { name: 'readFile', args: { path: 'src/app.ts' } }, permissions: { edits: 'ask' } },
    ]);
    expect(model.calls[0].options.tools).toEqual(toolSpecsFor(['readFile', 'searchText']));
    expect(model.calls[1].messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'readFile', arguments: '{"path":"src/app.ts"}' }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'readFile', content: lines(120) },
    ]);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(io.logs.filter((l) => l.stream === 'tool')).toEqual([
      { stream: 'tool', text: 'readFile src/app.ts → 120 lines\n' },
    ]);
  });

  it('keeps text streamed alongside tool calls in the assistant message', async () => {
    const host = new FakeToolHost({ gitDiff: () => ({ content: 'diff --git a b' }) });
    const { model, options } = setup(
      [{ text: 'Let me check the diff.', toolCalls: [{ id: 'g', name: 'gitDiff', args: '' }] }, say('Done')],
      { tools: ['gitDiff'], toolHost: host },
    );
    await runAgentLoop(options);
    expect(model.calls[1].messages[1]).toEqual({
      role: 'assistant',
      content: 'Let me check the diff.',
      toolCalls: [{ id: 'g', name: 'gitDiff', arguments: '' }],
    });
    expect(host.calls[0].call).toEqual({ name: 'gitDiff', args: {} });
  });

  it('executes several calls of one turn in order', async () => {
    const order: string[] = [];
    const host = new FakeToolHost({
      readFile: (c) => (order.push(`read ${String(c.args.path)}`), { content: 'x' }),
      editFile: (c) => (order.push(`edit ${String(c.args.path)}`), { content: 'Edited' }),
    });
    const { model, options } = setup(
      [
        callTools(
          { id: 'a', name: 'readFile', args: { path: 'a.ts' } },
          { id: 'b', name: 'editFile', args: { path: 'a.ts', oldText: 'x', newText: 'y' } },
        ),
        say('ok'),
      ],
      { tools: ['readFile', 'editFile'], toolHost: host },
    );
    await runAgentLoop(options);
    expect(order).toEqual(['read a.ts', 'edit a.ts']);
    expect(toolMessages(model.calls[1].messages).map((m) => (m.role === 'tool' ? m.toolCallId : ''))).toEqual(
      ['a', 'b'],
    );
  });

  it('generates ids for tool calls that have none', async () => {
    const host = new FakeToolHost({ listFiles: () => ({ content: 'a.ts' }) });
    const { model, options } = setup([callTools({ id: '', name: 'listFiles', args: {} }), say('ok')], {
      tools: ['listFiles'],
      toolHost: host,
    });
    await runAgentLoop(options);
    const [, assistant, tool] = model.calls[1].messages;
    const id = assistant.role === 'assistant' ? assistant.toolCalls?.[0].id : undefined;
    expect(id).toBeTruthy();
    expect(tool).toMatchObject({ role: 'tool', toolCallId: id });
  });

  it.each([
    ['malformed JSON', '{"path": "a.ts"', /^Invalid JSON arguments: .+/],
    ['a non-object', '["a.ts"]', /^Invalid JSON arguments: expected a JSON object, got array\./],
    [
      'missing required arguments',
      '{}',
      /^Invalid arguments for readFile: path: missing \(expected string\)/,
    ],
  ])('returns an error result for %s', async (_label, args, message) => {
    const host = new FakeToolHost({ readFile: () => ({ content: 'should not run' }) });
    const { model, io, options } = setup([callTools({ id: 'x', name: 'readFile', args }), say('Sorry')], {
      tools: ['readFile'],
      toolHost: host,
    });

    const result = await runAgentLoop(options);

    expect(result.text).toBe('Sorry');
    expect(host.calls).toHaveLength(0);
    const [tool] = toolMessages(model.calls[1].messages);
    expect(tool).toMatchObject({ role: 'tool', toolCallId: 'x', name: 'readFile', isError: true });
    expect(tool.content).toMatch(message);
    expect(io.textOf('tool')).toMatch(/^readFile → failed: /);
  });

  it('drops null arguments that models send for unused optional parameters', async () => {
    const host = new FakeToolHost({ readFile: () => ({ content: 'x' }) });
    const { options } = setup(
      [
        callTools({ name: 'readFile', args: '{"path": "a.ts", "startLine": null, "endLine": null}' }),
        say('ok'),
      ],
      { tools: ['readFile'], toolHost: host },
    );
    await runAgentLoop(options);
    expect(host.calls[0].call.args).toEqual({ path: 'a.ts' });
  });

  it('rejects null as the whole argument value', async () => {
    const host = new FakeToolHost({ listFiles: () => ({ content: 'x' }) });
    const { model, options } = setup([callTools({ name: 'listFiles', args: 'null' }), say('ok')], {
      tools: ['listFiles'],
      toolHost: host,
    });
    await runAgentLoop(options);
    expect(host.calls).toHaveLength(0);
    expect(toolMessages(model.calls[1].messages)[0].content).toBe(
      'Invalid JSON arguments: expected a JSON object, got null.',
    );
  });

  it('refuses tools that are not enabled for the agent', async () => {
    const host = new FakeToolHost({ editFile: () => ({ content: 'Edited' }) });
    const { model, options } = setup(
      [
        callTools({ id: 'e', name: 'editFile', args: { path: 'a.ts', oldText: 'a', newText: 'b' } }),
        say('ok'),
      ],
      { tools: ['readFile', 'listFiles'], toolHost: host },
    );
    await runAgentLoop(options);
    expect(host.calls).toHaveLength(0);
    const [tool] = toolMessages(model.calls[1].messages);
    expect(tool).toMatchObject({ isError: true });
    expect(tool.content).toBe(
      'The tool "editFile" is not enabled for this agent. Available tools: readFile, listFiles.',
    );
  });

  it('refuses unknown tools', async () => {
    const host = new FakeToolHost();
    const { model, options } = setup([callTools({ id: 'u', name: 'deleteRepo', args: {} }), say('ok')], {
      tools: ['readFile'],
      toolHost: host,
    });
    await runAgentLoop(options);
    const [tool] = toolMessages(model.calls[1].messages);
    expect(tool).toMatchObject({
      isError: true,
      content: 'Unknown tool "deleteRepo". Available tools: readFile.',
    });
  });

  it('explains that no tools exist when the agent has none', async () => {
    const { model, options } = setup([
      callTools({ id: 'u', name: 'readFile', args: { path: 'a' } }),
      say('ok'),
    ]);
    await runAgentLoop(options);
    const [tool] = toolMessages(model.calls[1].messages);
    expect(tool.content).toBe('The tool "readFile" is not enabled for this agent. This agent has no tools.');
  });

  it('returns an error result when no tool host is available', async () => {
    const { model, options } = setup(
      [callTools({ id: 'r', name: 'readFile', args: { path: 'a.ts' } }), say('ok')],
      {
        tools: ['readFile'],
      },
    );
    await runAgentLoop(options);
    const [tool] = toolMessages(model.calls[1].messages);
    expect(tool).toMatchObject({ isError: true });
    expect(tool.content).toMatch(/cannot run here/);
  });

  it('passes tool errors from the host back to the model', async () => {
    const host = new FakeToolHost({
      editFile: () => ({
        content: 'Edits are not allowed for this agent (permissions.edits is none).',
        isError: true,
      }),
    });
    const { model, io, options } = setup(
      [
        callTools({ id: 'e', name: 'editFile', args: { path: 'a.ts', oldText: 'a', newText: 'b' } }),
        say('ok'),
      ],
      { tools: ['editFile'], toolHost: host },
    );
    await runAgentLoop(options);
    expect(toolMessages(model.calls[1].messages)[0]).toMatchObject({ isError: true });
    expect(io.textOf('tool')).toBe(
      'editFile a.ts → failed: Edits are not allowed for this agent (permissions.edits is none).\n',
    );
  });

  it('turns exceptions from the tool host into error results', async () => {
    const host = new FakeToolHost({
      readFile: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    const { model, options } = setup(
      [callTools({ id: 'r', name: 'readFile', args: { path: 'a.ts' } }), say('ok')],
      {
        tools: ['readFile'],
        toolHost: host,
      },
    );
    await runAgentLoop(options);
    expect(toolMessages(model.calls[1].messages)[0]).toMatchObject({
      isError: true,
      content: 'The tool failed: EACCES: permission denied',
    });
  });
});

describe('runAgentLoop: limits and cancellation', () => {
  const readCall = () => callTools({ name: 'readFile', args: { path: 'a.ts' } });

  it('fails when the agent uses all turns without a final answer', async () => {
    const host = new FakeToolHost({ readFile: () => ({ content: 'x' }) });
    const { model, options } = setup([readCall(), readCall(), say('never reached')], {
      tools: ['readFile'],
      toolHost: host,
      maxTurns: 2,
    });

    await expect(runAgentLoop(options)).rejects.toThrow(
      'The agent used all 2 turns without giving a final answer. Increase maxTurns or simplify the task.',
    );
    expect(model.calls).toHaveLength(2);
    expect(host.calls).toHaveLength(1);
  });

  it('allows 20 turns by default', async () => {
    const host = new FakeToolHost({ readFile: () => ({ content: 'x' }) });
    const turns = Array.from({ length: 21 }, readCall);
    const { model, options } = setup(turns, { tools: ['readFile'], toolHost: host });
    await expect(runAgentLoop(options)).rejects.toThrow(/all 20 turns/);
    expect(model.calls).toHaveLength(20);
  });

  it('does not call the model when already aborted', async () => {
    const { model, io, options } = setup([say('hi')]);
    io.controller.abort();
    await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.calls).toHaveLength(0);
  });

  it('stops while the answer streams', async () => {
    const { io, options } = setup([]);
    const model = new FakeModel([{ text: ['a', 'b', 'c'], onStream: () => io.controller.abort() }]);
    await expect(runAgentLoop({ ...options, model })).rejects.toMatchObject({ name: 'AbortError' });
    expect(io.textOf('agent')).toBe('a');
  });

  it('stops after a tool call when cancelled meanwhile', async () => {
    const io = recordingIO();
    const host = new FakeToolHost({
      readFile: () => {
        io.controller.abort();
        return { content: 'x' };
      },
    });
    const { model, options } = setup(
      [readCall(), say('never')],
      { tools: ['readFile'], toolHost: host },
      {},
      io,
    );
    await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.calls).toHaveLength(1);
  });

  it('rethrows the abort reason given by the caller', async () => {
    const { io, options } = setup([]);
    const reason = new Error('Step timed out after 30 s');
    const model = new FakeModel([{ text: ['a', 'b'], onStream: () => io.controller.abort(reason) }]);
    await expect(runAgentLoop({ ...options, model })).rejects.toBe(reason);
  });

  it('throws an aborted ModelError when the abort reason is not an Error', async () => {
    const { model, io, options } = setup([say('hi')]);
    io.controller.abort('user pressed stop');
    await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'ModelError', kind: 'aborted' });
    expect(model.calls).toHaveLength(0);
  });

  it('does not run the remaining calls of a turn after a cancel', async () => {
    const io = recordingIO();
    const host = new FakeToolHost({
      readFile: () => {
        io.controller.abort();
        return { content: 'x' };
      },
      editFile: () => ({ content: 'Edited' }),
    });
    const turns = [
      callTools(
        { name: 'readFile', args: { path: 'a.ts' } },
        { name: 'editFile', args: { path: 'a.ts', oldText: 'x', newText: 'y' } },
      ),
    ];
    const { options } = setup(turns, { tools: ['readFile', 'editFile'], toolHost: host }, {}, io);
    await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.calls.map((c) => c.call.name)).toEqual(['readFile']);
  });

  it('rethrows a tool host abort instead of reporting it to the model', async () => {
    const io = recordingIO();
    const host = new FakeToolHost({
      runCommand: () => {
        io.controller.abort();
        throw new Error('Command was killed');
      },
    });
    const turns = [callTools({ name: 'runCommand', args: { command: 'npm test' } }), say('never')];
    const { options } = setup(turns, { tools: ['runCommand'], toolHost: host }, {}, io);
    await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('runAgentLoop: JSON answers', () => {
  const output = { format: 'json' as const, schema: { approved: 'boolean', issues: 'string[]' } };

  it('asks for JSON in the prompt and parses a fenced answer', async () => {
    const { model, options } = setup([say('```json\n{"approved": true, "issues": []}\n```')], { output });

    const result = await runAgentLoop(options);

    expect(result.json).toEqual({ approved: true, issues: [] });
    expect(result.text).toBe('```json\n{"approved": true, "issues": []}\n```');
    const prompt = model.calls[0].messages[0].content;
    expect(prompt.startsWith('Review the change.\n\n')).toBe(true);
    expect(prompt).toMatch(/JSON only/);
    expect(prompt).toContain('"approved": boolean');
    expect(prompt).toContain('"issues": string[]');
    expect(result.messages[0].content).toBe(prompt);
  });

  it('extracts JSON surrounded by prose', async () => {
    const { options } = setup([say('Here is my verdict: {"approved": false, "issues": ["typo"]} Cheers.')], {
      output,
    });
    expect((await runAgentLoop(options)).json).toEqual({ approved: false, issues: ['typo'] });
  });

  it('sends a JSON schema only when the model supports it', async () => {
    const supported = setup([say('{"approved": true, "issues": []}')], { output }, { jsonSchema: true });
    await runAgentLoop(supported.options);
    expect(supported.model.calls[0].options.jsonSchema).toEqual({
      name: 'answer',
      schema: {
        type: 'object',
        properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
        required: ['approved', 'issues'],
      },
    });

    const unsupported = setup([say('{"approved": true, "issues": []}')], { output }, { jsonSchema: false });
    await runAgentLoop(unsupported.options);
    expect(unsupported.model.calls[0].options.jsonSchema).toBeUndefined();
  });

  it('accepts any JSON when no schema is given', async () => {
    const { model, options } = setup(
      [say('[1, 2, 3]')],
      { output: { format: 'json' } },
      { jsonSchema: true },
    );
    const result = await runAgentLoop(options);
    expect(result.json).toEqual([1, 2, 3]);
    expect(model.calls[0].options.jsonSchema).toBeUndefined();
    expect(model.calls[0].messages[0].content).toMatch(/JSON only/);
  });

  it('does not touch the prompt or parse JSON for text output', async () => {
    const { model, options } = setup([say('{"a": 1}')], { output: { format: 'text' } });
    const result = await runAgentLoop(options);
    expect(result.json).toBeUndefined();
    expect(model.calls[0].messages[0].content).toBe('Review the change.');
  });

  it('repairs an invalid answer once', async () => {
    const { model, io, options } = setup(
      [
        say('I approve.', { inputTokens: 3, outputTokens: 1 }),
        say('{"approved": true, "issues": []}', { inputTokens: 4, outputTokens: 2 }),
      ],
      { output },
    );

    const result = await runAgentLoop(options);

    expect(result.json).toEqual({ approved: true, issues: [] });
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    const second = model.calls[1].messages;
    expect(second[1]).toEqual({ role: 'assistant', content: 'I approve.' });
    expect(second[2].role).toBe('user');
    expect(second[2].content).toContain('does not contain a JSON object or array');
    expect(second[2].content).toContain('"approved": boolean');
    expect(io.textOf('info')).toMatch(/not valid JSON.*asking the agent to correct it/);
  });

  it('lists shape problems in the repair request', async () => {
    const { model, options } = setup(
      [say('{"approved": "yes"}'), say('{"approved": true, "issues": ["a"]}')],
      { output },
    );
    await runAgentLoop(options);
    const repair = model.calls[1].messages[2].content;
    expect(repair).toContain('- approved: expected boolean, got string "yes"');
    expect(repair).toContain('- issues: missing (expected string[])');
  });

  it('fails after one unsuccessful repair', async () => {
    const { model, options } = setup([say('nope'), say('{"approved": 1}'), say('unused')], { output });
    await expect(runAgentLoop(options)).rejects.toThrow(
      /^The agent's answer is not valid JSON for the expected shape: approved: expected boolean, got number 1; issues: missing/,
    );
    expect(model.calls).toHaveLength(2);
  });

  it('does not let the repair round run tools beyond maxTurns', async () => {
    const host = new FakeToolHost({ readFile: () => ({ content: 'x' }) });
    const { model, options } = setup(
      [say('nope'), callTools({ name: 'readFile', args: { path: 'a.ts' } }), say('unused')],
      { output, maxTurns: 1, tools: ['readFile'], toolHost: host },
    );
    await expect(runAgentLoop(options)).rejects.toThrow(/all 1 turns/);
    expect(model.calls).toHaveLength(2);
    expect(host.calls).toHaveLength(0);
  });

  it('allows the repair round even when maxTurns is used up', async () => {
    const { options } = setup([say('nope'), say('{"approved": true, "issues": []}')], {
      output,
      maxTurns: 1,
    });
    expect((await runAgentLoop(options)).json).toEqual({ approved: true, issues: [] });
  });

  it('picks the JSON that fits the shape when prose contains other brackets', async () => {
    const { model, options } = setup(
      [say('Checklist:\n- [x] tests\n- [ ] docs\n\n{"approved": true, "issues": []}'), say('unused')],
      { output },
    );
    const result = await runAgentLoop(options);
    expect(result.json).toEqual({ approved: true, issues: [] });
    expect(model.calls).toHaveLength(1);
  });

  it('describes a JSON Schema in the prompt and sends it unchanged', async () => {
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['approve', 'reject'] } },
      required: ['verdict'],
    };
    const { model, options } = setup(
      [say('{"verdict": "approve"}')],
      { output: { format: 'json', schema } },
      {
        jsonSchema: true,
      },
    );
    const result = await runAgentLoop(options);
    expect(result.json).toEqual({ verdict: 'approve' });
    expect(model.calls[0].options.jsonSchema).toEqual({ name: 'answer', schema });
    expect(model.calls[0].messages[0].content).toContain(`JSON Schema:\n${JSON.stringify(schema, null, 2)}`);
  });

  it('repairs an answer without JSON when no schema is given', async () => {
    const { model, options } = setup([say('Sure, all good.'), say('{"ok": true}')], {
      output: { format: 'json' },
    });
    const result = await runAgentLoop(options);
    expect(result.json).toEqual({ ok: true });
    expect(model.calls[1].messages[2].content).toMatch(/does not contain a JSON object or array/);
    expect(model.calls[1].messages[2].content).not.toMatch(/shape \(keys/);
  });

  it('rejects compact types inside a JSON Schema before calling the model', async () => {
    const { model, options } = setup([say('{}')], {
      output: { format: 'json', schema: { type: 'object', properties: { approved: 'boolean' } } },
    });
    await expect(runAgentLoop(options)).rejects.toThrow(
      /^The output schema is invalid: approved: "boolean" is a compact type/,
    );
    expect(model.calls).toHaveLength(0);
  });

  it('rejects an invalid output schema before calling the model', async () => {
    const { model, options } = setup([say('{}')], {
      output: { format: 'json', schema: { approved: 'bool' } },
    });
    await expect(runAgentLoop(options)).rejects.toThrow(
      /^The output schema is invalid: approved: unknown type "bool"/,
    );
    expect(model.calls).toHaveLength(0);
  });
});
