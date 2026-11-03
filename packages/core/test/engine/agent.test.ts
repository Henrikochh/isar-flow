import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, run, workflow } from './helpers';

const reviewer: AgentDefinition = {
  name: 'Reviewer',
  model: 'litellm/claude',
  fallbackModels: ['vscode/copilot/gpt-4.1'],
  systemPrompt: 'Be strict.',
  temperature: 0.2,
  tools: ['readFile'],
  permissions: { edits: 'none', commands: 'none' },
};

describe('agent resolution', () => {
  it('resolves an agent file by id and sends the rendered request', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([
        {
          id: 'review',
          type: 'agent',
          agent: 'reviewer',
          prompt: 'Review ${{ inputs.task }}',
          output: { format: 'json', schema: { approved: 'boolean' } },
          context: { files: ['src/**/*.ts', 'docs/${{ inputs.doc }}'] },
        },
      ]),
      { host, agents: { reviewer }, inputs: { task: 'login', doc: 'a.md' } },
    );
    expect(host.agentCalls).toEqual([
      {
        stepId: 'review',
        agentId: 'reviewer',
        agent: {
          name: 'Reviewer',
          model: 'litellm/claude',
          fallbackModels: ['vscode/copilot/gpt-4.1'],
          systemPrompt: 'Be strict.',
          temperature: 0.2,
          tools: ['readFile'],
          permissions: { edits: 'none', commands: 'none' },
        },
        prompt: 'Review login',
        output: { format: 'json', schema: { approved: 'boolean' } },
        history: [],
        contextFiles: ['src/**/*.ts', 'docs/a.md'],
      },
    ]);
    expect(eventsOfType(r.events, 'step-start')[0]).toMatchObject({
      stepType: 'agent',
      detail: 'Review login',
    });
  });

  it('lets the block model override the agent model', async () => {
    const host = new FakeHost();
    await run(
      workflow([{ id: 'a', type: 'agent', agent: 'reviewer', model: 'ollama/llama3', prompt: 'p' }]),
      {
        host,
        agents: { reviewer },
      },
    );
    expect(host.agentCalls[0].agent.model).toBe('ollama/llama3');
  });

  it('passes the tool mode of agent files and inline agents', async () => {
    const host = new FakeHost();
    await run(
      workflow([
        { id: 'a', type: 'agent', agent: 'texty', prompt: 'p' },
        { id: 'b', type: 'agent', agent: { model: 'litellm/x', toolMode: 'native' }, prompt: 'q' },
        { id: 'c', type: 'agent', model: 'litellm/y', prompt: 'r' },
      ]),
      { host, agents: { texty: { name: 'Texty', model: 'ollama/llama3', toolMode: 'text' } } },
    );
    expect(host.agentCalls.map((call) => call.agent.toolMode)).toEqual(['text', 'native', undefined]);
    expect(host.agentCalls[2].agent).not.toHaveProperty('toolMode');
  });

  it('passes the memory mode of agent files and inline agents', async () => {
    const host = new FakeHost();
    await run(
      workflow([
        { id: 'a', type: 'agent', agent: 'scribe', prompt: 'p' },
        { id: 'b', type: 'agent', agent: { model: 'litellm/x', memory: 'none' }, prompt: 'q' },
        { id: 'c', type: 'agent', model: 'litellm/y', prompt: 'r' },
      ]),
      { host, agents: { scribe: { name: 'Scribe', model: 'ollama/llama3', memory: 'write' } } },
    );
    expect(host.agentCalls.map((call) => call.agent.memory)).toEqual(['write', 'none', undefined]);
    expect(host.agentCalls[2].agent).not.toHaveProperty('memory');
  });

  it('accepts inline agents and names them after the block', async () => {
    const host = new FakeHost();
    await run(
      workflow([
        { id: 'helper', type: 'agent', agent: { model: 'litellm/x', systemPrompt: 'Help.' }, prompt: 'p' },
        { id: 'bare', type: 'agent', model: 'litellm/y', prompt: 'q' },
      ]),
      { host },
    );
    expect(host.agentCalls[0]).toMatchObject({
      agent: { name: 'helper', model: 'litellm/x', systemPrompt: 'Help.' },
    });
    expect(host.agentCalls[0].agentId).toBeUndefined();
    expect(host.agentCalls[1].agent).toEqual({ name: 'bare', model: 'litellm/y' });
    expect(host.agentCalls[1].contextFiles).toEqual([]);
  });

  it('fails with a helpful message when the agent file does not exist', async () => {
    const host = new FakeHost();
    const r = await run(
      workflow([{ id: 'a', type: 'agent', agent: 'ghost', prompt: 'p', retry: { max: 2 } }]),
      {
        host,
      },
    );
    expect(r.error('a')).toBe(
      "Agent 'ghost' not found. Create .isarflow/agents/ghost.agent.yaml or pick another agent.",
    );
    expect(r.summary.status).toBe('failure');
    expect(host.calls).toHaveLength(0);
    expect(r.trace).toEqual(['run-start', 'start:a', 'end:a:failure', 'run:failure']);
  });

  it('does not treat prototype keys as agent ids', async () => {
    const r = await run(workflow([{ id: 'a', type: 'agent', agent: 'constructor', prompt: 'p' }]));
    expect(r.error('a')).toMatch(/^Agent 'constructor' not found/);
  });

  it('fails when no model is set', async () => {
    const r = await run(workflow([{ id: 'a', type: 'agent', agent: { systemPrompt: 'x' }, prompt: 'p' }]));
    expect(r.error('a')).toMatch(/^No model set for block 'a'\./);
  });

  it('reports expression errors in the prompt and context files', async () => {
    const r = await run(workflow([{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x ${{ + }}' }]));
    expect(r.error('a')).toMatch(/^Expression error in prompt: /);
    const r2 = await run(
      workflow([
        { id: 'a', type: 'agent', model: 'p/m', prompt: 'p', context: { files: ['ok', '${{ ) }}'] } },
      ]),
    );
    expect(r2.error('a')).toMatch(/^Expression error in context\.files\[1\]: /);
  });
});

describe('agent outputs', () => {
  it('exposes text, json, model, usage, turns, tool calls and status', async () => {
    const host = new FakeHost().agent('review', {
      text: '{"approved":true}',
      json: { approved: true },
      model: 'vscode/copilot/gpt-4.1',
      usage: { inputTokens: 100, outputTokens: 20 },
      turns: 3,
      toolCalls: 4,
    });
    const r = await run(
      workflow([
        { id: 'review', type: 'agent', agent: 'reviewer', prompt: 'p' },
        {
          id: 'after',
          type: 'console',
          run: '${{ steps.review.json.approved }} ${{ steps.review.usage.inputTokens }}',
        },
      ]),
      { host, agents: { reviewer } },
    );
    expect(r.output('review')).toEqual({
      text: '{"approved":true}',
      json: { approved: true },
      model: 'vscode/copilot/gpt-4.1',
      usage: { inputTokens: 100, outputTokens: 20 },
      turns: 3,
      toolCalls: 4,
      status: 'success',
      durationMs: expect.any(Number),
    });
    expect(host.consoleCalls[0].command).toBe('true 100');
    expect(r.summary.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('reports 0 tool calls when the host does not count them', async () => {
    const r = await run(
      workflow([
        { id: 'a', type: 'agent', model: 'p/m', prompt: 'x' },
        { id: 'b', type: 'console', run: 'calls ${{ steps.a.toolCalls }}' },
      ]),
    );
    expect(r.output('a')).toMatchObject({ toolCalls: 0, turns: 1 });
    expect(r.host.consoleCalls[0].command).toBe('calls 0');
  });

  it('accumulates usage across agent blocks into run-end and the summary', async () => {
    const host = new FakeHost()
      .agent('a', { usage: { inputTokens: 10, outputTokens: 1 } })
      .agent('b', { usage: { inputTokens: 5, outputTokens: 2 } });
    const r = await run(
      workflow([
        { id: 'a', type: 'agent', model: 'p/m', prompt: 'x' },
        { id: 'b', type: 'agent', model: 'p/m', prompt: 'y' },
      ]),
      { host },
    );
    expect(r.summary.usage).toEqual({ inputTokens: 15, outputTokens: 3 });
    expect(r.events.at(-1)).toMatchObject({ type: 'run-end', usage: { inputTokens: 15, outputTokens: 3 } });
  });

  it('turns agent errors into block failures', async () => {
    const host = new FakeHost().agent('a', { error: "Model 'litellm/x' is not available" });
    const r = await run(workflow([{ id: 'a', type: 'agent', model: 'litellm/x', prompt: 'p' }]), { host });
    expect(r.error('a')).toBe("Model 'litellm/x' is not available");
    expect(r.summary.status).toBe('failure');
  });
});

describe('token budget', () => {
  const steps = [
    { id: 'a', type: 'agent' as const, model: 'p/m', prompt: 'x' },
    { id: 'b', type: 'agent' as const, model: 'p/m', prompt: 'y' },
    { id: 'c', type: 'console' as const, run: 'never' },
  ];

  it('fails the run once the total exceeds the budget', async () => {
    const host = new FakeHost()
      .agent('a', { usage: { inputTokens: 40, outputTokens: 10 } })
      .agent('b', { usage: { inputTokens: 40, outputTokens: 20 } });
    const r = await run(workflow(steps), { host, tokenBudget: 100 });
    expect(r.trace).toEqual([
      'run-start',
      'start:a',
      'end:a:success',
      'start:b',
      'end:b:success',
      'run:failure',
    ]);
    expect(r.summary.error).toMatch(/^Token budget exceeded: used 110 of 100 tokens\./);
    expect(r.summary.usage).toEqual({ inputTokens: 80, outputTokens: 30 });
  });

  it('allows a run that uses exactly the budget', async () => {
    const host = new FakeHost()
      .agent('a', { usage: { inputTokens: 30, outputTokens: 20 } })
      .agent('b', { usage: { inputTokens: 40, outputTokens: 10 } });
    const r = await run(workflow(steps), { host, tokenBudget: 100 });
    expect(r.summary.status).toBe('success');
    expect(r.summary.usage).toEqual({ inputTokens: 70, outputTokens: 30 });
  });

  it('allows a run that stays within the budget or has no budget', async () => {
    const host = new FakeHost().agent('a', { usage: { inputTokens: 50, outputTokens: 50 } });
    expect((await run(workflow(steps), { host, tokenBudget: 100 })).summary.status).toBe('success');
    const host2 = new FakeHost().agent('a', { usage: { inputTokens: 5000, outputTokens: 50 } });
    expect((await run(workflow(steps), { host: host2, tokenBudget: 0 })).summary.status).toBe('success');
  });

  it('cannot be bypassed with continueOnError and ends enclosing loops', async () => {
    const host = new FakeHost().agent('a', { usage: { inputTokens: 60, outputTokens: 60 } });
    const r = await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 3,
          continueOnError: true,
          steps: [{ id: 'a', type: 'agent', model: 'p/m', prompt: 'x', continueOnError: true }],
        },
      ]),
      { host, tokenBudget: 100 },
    );
    expect(r.trace).toEqual([
      'run-start',
      'start:l',
      'iter:l:1',
      'start:a',
      'end:a:success',
      'end:l:failure',
      'run:failure',
    ]);
    expect(r.summary.error).toMatch(/^Token budget exceeded/);
  });
});

describe('sessions', () => {
  it('passes the previous conversation of the block with session: continue', async () => {
    const host = new FakeHost().agent('chat', { text: 'first' }, { text: 'second' }, { text: 'third' });
    await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 3,
          steps: [
            {
              id: 'chat',
              type: 'agent',
              model: 'p/m',
              prompt: 'round ${{ loop.iteration }}',
              session: 'continue',
            },
          ],
        },
      ]),
      { host },
    );
    const histories = host.agentCalls.map((c) => c.history);
    expect(histories[0]).toEqual([]);
    expect(histories[1]).toEqual([
      { role: 'user', content: 'round 1' },
      { role: 'assistant', content: 'first' },
    ]);
    expect(histories[2]).toEqual([
      { role: 'user', content: 'round 1' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'round 2' },
      { role: 'assistant', content: 'second' },
    ]);
  });

  it('starts fresh by default and keeps sessions per block', async () => {
    const host = new FakeHost();
    await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 2,
          steps: [
            { id: 'fresh', type: 'agent', model: 'p/m', prompt: 'f' },
            { id: 'cont', type: 'agent', model: 'p/m', prompt: 'c', session: 'continue' },
          ],
        },
      ]),
      { host },
    );
    const byStep = (id: string) =>
      host.agentCalls.filter((c) => c.stepId === id).map((c) => c.history.length);
    expect(byStep('fresh')).toEqual([0, 0]);
    expect(byStep('cont')).toEqual([0, 2]);
  });

  it('does not store the conversation of a failed attempt', async () => {
    const host = new FakeHost().agent('chat', { error: 'flaky' }, { text: 'ok' });
    await run(
      workflow([
        {
          id: 'l',
          type: 'loop',
          maxIterations: 2,
          steps: [
            {
              id: 'chat',
              type: 'agent',
              model: 'p/m',
              prompt: 'p',
              session: 'continue',
              continueOnError: true,
            },
          ],
        },
      ]),
      { host },
    );
    expect(host.agentCalls.map((c) => c.history.length)).toEqual([0, 0]);
  });
});
