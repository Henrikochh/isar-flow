import { describe, expect, it, vi } from 'vitest';
import { type AgentLoopOptions, REMEMBER_TOOL, runAgentLoop, toolSpecsFor } from '../../src/agent';
import type { AgentMemory } from '../../src/agent/types';
import type { StepIO } from '../../src/engine/types';
import type { ModelCapabilities } from '../../src/models/types';
import { callTools, FakeModel, type FakeTurn, say, textCall } from '../fakes/fakeModel';
import { FakeToolHost, recordingIO } from './helpers';

const SECTION_HEAD =
  '## Project memory\n\nNotes saved in .isarflow/memory.md by earlier runs. Use them as background; the task has ' +
  'priority.';
const REMEMBER_HINT =
  'Use the remember tool to save a short, durable fact about this project for later runs, one per call.';

function rememberer(impl?: (note: string, io: StepIO) => Promise<string>) {
  return vi.fn(impl ?? (async (note: string) => `- 2026-11-03: ${note.trim()}`));
}

function setup(
  turns: FakeTurn[],
  memory: AgentMemory | undefined,
  overrides: Partial<AgentLoopOptions> = {},
  capabilities: Partial<ModelCapabilities> = {},
) {
  const host = new FakeToolHost({
    readFile: (call) => ({ content: `content of ${String(call.args.path)}` }),
  });
  const io = recordingIO();
  const model = new FakeModel(turns, { capabilities });
  const options: AgentLoopOptions = {
    model,
    systemPrompt: 'You are careful.',
    prompt: 'Fix the bug.',
    tools: ['readFile'],
    toolHost: host,
    permissions: {},
    io,
    ...(memory && { memory }),
    ...overrides,
  };
  return { model, host, io, options };
}

describe('runAgentLoop: project memory in the system prompt', () => {
  it('appends the notes to the system prompt', async () => {
    const { model, options } = setup([say('ok')], { text: '- 2026-11-01: Use pnpm.\n' });
    await runAgentLoop(options);
    expect(model.calls[0].messages[0]).toEqual({
      role: 'system',
      content: `You are careful.\n\n${SECTION_HEAD}\n\n- 2026-11-01: Use pnpm.`,
    });
    expect(model.calls[0].options.tools).toEqual(toolSpecsFor(['readFile']));
  });

  it('is the system prompt when the agent has none', async () => {
    const { model, options } = setup(
      [say('ok')],
      { text: '- a', truncated: true },
      { systemPrompt: undefined },
    );
    await runAgentLoop(options);
    expect(model.calls[0].messages[0]).toEqual({
      role: 'system',
      content: `${SECTION_HEAD}\n\n- a\n\n(Only the beginning of the file is shown.)`,
    });
  });

  it('adds nothing for blank notes without remember', async () => {
    const { model, options } = setup([say('ok')], { text: ' \n' });
    await runAgentLoop(options);
    expect(model.calls[0].messages[0]).toEqual({ role: 'system', content: 'You are careful.' });
  });

  it('keeps the memory when the conversation is compacted', async () => {
    const { model, options } = setup(
      [
        callTools({ name: 'readFile', args: { path: 'a.ts' } }),
        callTools({ name: 'readFile', args: { path: 'b.ts' } }),
        say('Summary.'),
        say('Done.'),
      ],
      { text: '- 2026-11-01: Use pnpm.' },
      {
        contextTokens: 2000,
        toolHost: new FakeToolHost({ readFile: () => ({ content: 'x'.repeat(3000) }) }),
      },
    );
    const result = await runAgentLoop(options);
    expect(result.text).toBe('Done.');
    expect(model.calls[3].messages[0].content).toBe(
      `You are careful.\n\n${SECTION_HEAD}\n\n- 2026-11-01: Use pnpm.`,
    );
  });
});

describe('runAgentLoop: remember with native tool calls', () => {
  it('offers remember after the agent tools and answers the call itself', async () => {
    const remember = rememberer();
    const { model, host, io, options } = setup(
      [callTools({ id: 'r1', name: 'remember', args: { note: 'Tests run with npm test.' } }), say('Done.')],
      { text: '- old', remember },
    );

    const result = await runAgentLoop(options);

    expect(result.text).toBe('Done.');
    expect(result.toolCalls).toBe(1);
    expect(model.calls[0].options.tools).toEqual([...toolSpecsFor(['readFile']), REMEMBER_TOOL]);
    expect(model.calls[0].messages[0].content).toBe(
      `You are careful.\n\n${SECTION_HEAD}\n\n- old\n\n${REMEMBER_HINT}`,
    );
    expect(remember).toHaveBeenCalledWith('Tests run with npm test.', io);
    expect(host.calls).toEqual([]);
    expect(result.messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'r1',
      name: 'remember',
      content: 'Saved to the project memory: - 2026-11-03: Tests run with npm test.',
    });
    expect(io.textOf('tool')).toBe('remember: Tests run with npm test. → saved\n');
  });

  it('opens a tool channel for an agent without tools', async () => {
    const remember = rememberer();
    const { model, options } = setup(
      [callTools({ name: 'remember', args: { note: 'x' } }), say('ok')],
      { remember },
      { tools: [], toolHost: undefined },
    );
    await runAgentLoop(options);
    expect(model.calls[0].options.tools).toEqual([REMEMBER_TOOL]);
    expect(model.calls[0].messages[0].content).toBe(
      `You are careful.\n\n## Project memory\n\nNo notes are saved in .isarflow/memory.md yet.\n\n${REMEMBER_HINT}`,
    );
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('returns a rejection as a tool error and goes on', async () => {
    const remember = rememberer(async () => {
      throw new Error('The note is too long (612 characters). Keep it under 500 characters.');
    });
    const long = `${'x'.repeat(100)} more`;
    const { io, options } = setup([callTools({ name: 'remember', args: { note: long } }), say('ok')], {
      remember,
    });
    const result = await runAgentLoop(options);
    expect(result.text).toBe('ok');
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      name: 'remember',
      content: 'The note is too long (612 characters). Keep it under 500 characters.',
      isError: true,
    });
    expect(io.textOf('tool')).toBe(
      `remember: ${'x'.repeat(79)}… → failed: The note is too long (612 characters). Keep it under 500 characters.\n`,
    );
  });

  it('checks the arguments before saving', async () => {
    const remember = rememberer();
    const { options } = setup(
      [
        callTools({ name: 'remember', args: {} }),
        callTools({ name: 'remember', args: { note: 42 } }),
        callTools({ name: 'remember', args: 'not json' }),
        say('ok'),
      ],
      { remember },
    );
    const result = await runAgentLoop(options);
    const errors = result.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(errors[0]).toMatch(/^Invalid arguments for remember: .*note/);
    expect(errors[1]).toMatch(/^Invalid arguments for remember: .*note/);
    expect(errors[2]).toMatch(/^Invalid JSON arguments/);
    expect(remember).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(3);
  });

  it('stops when the run is cancelled while saving', async () => {
    const io = recordingIO();
    const remember = rememberer(async () => {
      io.controller.abort(new Error('The run was cancelled.'));
      throw new Error('write interrupted');
    });
    const { model, options } = setup([callTools({ name: 'remember', args: { note: 'x' } }), say('ok')], {
      remember,
    });
    await expect(runAgentLoop({ ...options, io })).rejects.toThrow('The run was cancelled.');
    expect(model.calls).toHaveLength(1);
  });

  it('treats remember as an unknown tool without write access', async () => {
    const { host, options } = setup([callTools({ name: 'remember', args: { note: 'x' } }), say('ok')], {
      text: '- a',
    });
    const result = await runAgentLoop(options);
    expect(result.messages[2]).toMatchObject({
      content: 'Unknown tool "remember". Available tools: readFile.',
      isError: true,
    });
    expect(host.calls).toEqual([]);
  });

  it('lists remember among the available tools of refusals', async () => {
    const { options } = setup([callTools({ name: 'deleteAll', args: {} }), say('ok')], {
      remember: rememberer(),
    });
    const result = await runAgentLoop(options);
    expect(result.messages[2]).toMatchObject({
      content: 'Unknown tool "deleteAll". Available tools: readFile, remember.',
    });

    const only = setup([callTools({ name: 'readFile', args: { path: 'a' } }), say('ok')], {
      remember: rememberer(),
    });
    const second = await runAgentLoop({ ...only.options, tools: [] });
    expect(second.messages[2]).toMatchObject({
      content: 'The tool "readFile" is not enabled for this agent. Available tools: remember.',
    });
  });

  it('runs a remember call written as text by a model with native tools', async () => {
    const remember = rememberer();
    const { options } = setup([say(textCall('remember', { note: 'Use pnpm.' })), say('ok')], { remember });
    const result = await runAgentLoop(options);
    expect(remember).toHaveBeenCalledWith('Use pnpm.', expect.anything());
    expect(result.toolCalls).toBe(1);
  });

  it('leaves remember text alone without write access', async () => {
    const reply = textCall('remember', { note: 'Use pnpm.' });
    const { options } = setup([say(reply)], { text: '- a' });
    const result = await runAgentLoop(options);
    expect(result.text).toBe(reply);
    expect(result.toolCalls).toBe(0);
  });
});

describe('runAgentLoop: remember in text tool mode', () => {
  it('describes remember in the tool section and runs calls written as text', async () => {
    const remember = rememberer();
    const { model, io, options } = setup(
      [say(`Noting it.\n${textCall('remember', { note: 'The API lives in src/api.' })}`), say('Done.')],
      { remember },
      { toolMode: 'text' },
    );

    const result = await runAgentLoop(options);

    expect(result.text).toBe('Done.');
    expect(model.calls[0].options.tools).toBeUndefined();
    const system = model.calls[0].messages[0].content;
    expect(system).toContain(`${REMEMBER_HINT}\n\n## Tools`);
    expect(system).toContain(`### remember\n${REMEMBER_TOOL.description}`);
    expect(remember).toHaveBeenCalledWith('The API lives in src/api.', io);
    expect(model.calls[1].messages.at(-1)).toEqual({
      role: 'user',
      content:
        'Result of remember (call_1):\nSaved to the project memory: - 2026-11-03: The API lives in src/api.',
    });
  });

  it('uses text mode for an agent with only remember on a model without native tools', async () => {
    const remember = rememberer();
    const { model, io, options } = setup(
      [say(textCall('remember', { note: 'x' })), say('ok')],
      { remember },
      { tools: [], toolHost: undefined },
      { tools: false },
    );
    await runAgentLoop(options);
    const system = model.calls[0].messages[0].content;
    expect(system).toContain(
      'To call a tool, write the call in exactly this format, with the arguments as a JSON object:\n' +
        '<tool_call>{"name": "remember", "arguments": {"note": "Tests run with npm test."}}</tool_call>',
    );
    expect(io.textOf('info')).toContain('text tool mode');
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('asks for a corrected remember call that could not be read', async () => {
    const remember = rememberer();
    const { model, options } = setup(
      [say('<tool_call>{"name": "remember", "arguments": {note: x}}</tool_call>'), say('ok')],
      { remember },
      { toolMode: 'text' },
    );
    await runAgentLoop(options);
    expect(model.calls[1].messages.at(-1)?.content).toMatch(
      /^Your tool call could not be read: the call of remember is not valid JSON .*Reply with only the tool call, as <tool_call>\{"name": "remember", "arguments": \{"note": "…"\}\}<\/tool_call>\.$/,
    );
    expect(remember).not.toHaveBeenCalled();
  });
});
