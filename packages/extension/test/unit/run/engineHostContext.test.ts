import { describe, expect, it, vi } from 'vitest';
import type { AgentRequestDeps, AgentResult } from '@isar-flow/core';
import { createEngineHost } from '../../../src/run/engineHost';
import { FakeTerminal } from './fakes';

const seen: AgentRequestDeps[] = [];

vi.mock('@isar-flow/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@isar-flow/core')>()),
  executeAgentRequest: async (_request: unknown, deps: AgentRequestDeps): Promise<AgentResult> => {
    seen.push(deps);
    return {
      text: 'ok',
      model: 'fake/m',
      usage: { inputTokens: 0, outputTokens: 0 },
      turns: 1,
      messages: [],
    };
  },
}));

function engineHost(contextTokens?: number) {
  return createEngineHost({
    runId: 'run-1',
    workspaceRoot: '/ws',
    runCommand: async () => Promise.reject(new Error('unused')),
    terminal: new FakeTerminal(),
    models: { resolve: async () => Promise.reject(new Error('unused')) },
    toolHost: { execute: async () => ({ content: '' }) },
    readContextFiles: async () => [],
    approve: async () => ({ approved: true }),
    ...(contextTokens !== undefined && { contextTokens }),
  });
}

const request = {
  stepId: 'ask',
  agent: { name: 'A', model: 'fake/m' },
  prompt: 'Hi',
  history: [],
  contextFiles: [],
};
const io = { runId: 'run-1', stepId: 'ask', signal: new AbortController().signal, log: () => undefined };

describe('createEngineHost contextTokens', () => {
  it('passes the context size setting to the agent runtime', async () => {
    seen.length = 0;
    await engineHost(8000).runAgent(request, io);
    await engineHost().runAgent(request, io);
    expect(seen[0].contextTokens).toBe(8000);
    expect('contextTokens' in seen[1]).toBe(false);
  });
});
