import { describe, expect, it } from 'vitest';
import { type AgentLoopOptions, executeAgentRequest, runAgentLoop } from '../../src/agent';
import { AgentRunError } from '../../src/engine';
import type { AgentRequest } from '../../src/engine/types';
import { type ChatModel, ModelError, type ModelResolver } from '../../src/models/types';
import { callTools, FakeModel, type FakeTurn, say } from '../fakes/fakeModel';
import { FakeToolHost, type RecordingIO, recordingIO } from './helpers';

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
const readCall = (tokens = usage(10, 2)): FakeTurn => ({
  ...callTools({ name: 'readFile', args: { path: 'a.ts' } }),
  usage: tokens,
});

function loopOptions(turns: FakeTurn[], overrides: Partial<AgentLoopOptions> = {}, io = recordingIO()) {
  const options: AgentLoopOptions = {
    model: new FakeModel(turns),
    prompt: 'Review the change.',
    tools: ['readFile'],
    toolHost: new FakeToolHost({ readFile: () => ({ content: 'x' }) }),
    permissions: { edits: 'none', commands: 'none' },
    io,
    ...overrides,
  };
  return options;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

describe('AgentRunError', () => {
  it('is an Error that carries the usage and the original cause', () => {
    const cause = new ModelError('busy', 'server', 503);
    const error = new AgentRunError('busy', usage(3, 1), { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'AgentRunError', message: 'busy', usage: usage(3, 1) });
    expect(error.cause).toBe(cause);
    expect(error.toolCalls).toBeUndefined();
  });

  it('carries the number of tool calls made before the failure', () => {
    expect(new AgentRunError('busy', usage(3, 1), { toolCalls: 2 }).toolCalls).toBe(2);
  });
});

describe('runAgentLoop: usage of failed runs', () => {
  it('reports the usage when the agent runs out of turns', async () => {
    const error = await failure(runAgentLoop(loopOptions([readCall(), readCall()], { maxTurns: 2 })));
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({
      message:
        'The agent used all 2 turns without giving a final answer. Increase maxTurns or simplify the task.',
      usage: usage(20, 4),
      // The second call is not run: the turn limit ends the loop first.
      toolCalls: 1,
    });
  });

  it('reports the usage when the JSON repair fails', async () => {
    const options = loopOptions([say('nope', usage(4, 1)), say('still nope', usage(5, 2))], {
      output: { format: 'json', schema: { approved: 'boolean' } },
    });
    const error = await failure(runAgentLoop(options));
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ usage: usage(9, 3) });
    expect((error as Error).message).toMatch(/^The agent's answer is not valid JSON/);
  });

  it('reports the usage when the model fails in a later turn and keeps the model error as cause', async () => {
    const modelError = new ModelError('Invalid API key.', 'auth', 401);
    const error = await failure(runAgentLoop(loopOptions([readCall(usage(7, 1)), { error: modelError }])));
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ message: 'Invalid API key.', usage: usage(7, 1) });
    expect((error as Error).cause).toBe(modelError);
  });

  it('reports the usage when the run is cancelled after tokens were used', async () => {
    const io: RecordingIO = recordingIO();
    const reason = new Error('Timed out after 30 s');
    const turns: FakeTurn[] = [
      readCall(usage(6, 2)),
      { text: ['a', 'b'], onStream: () => io.controller.abort(reason) },
    ];
    const error = await failure(runAgentLoop(loopOptions(turns, {}, io)));
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ message: 'Timed out after 30 s', usage: usage(6, 2) });
    expect((error as Error).cause).toBe(reason);
  });

  it('throws the original error when no tokens were used', async () => {
    const modelError = new ModelError('Invalid API key.', 'auth', 401);
    await expect(runAgentLoop(loopOptions([{ error: modelError }]))).rejects.toBe(modelError);
  });
});

describe('executeAgentRequest: usage of failed runs', () => {
  const request = (fallbackModels: string[] = []): AgentRequest => ({
    stepId: 'review',
    agent: { name: 'Reviewer', model: 'main/model', tools: ['readFile'], fallbackModels },
    prompt: 'Review the change.',
    history: [],
    contextFiles: [],
  });
  const resolver = (models: Record<string, ChatModel>): ModelResolver => ({
    resolve: async (ref) => {
      const model = models[ref];
      if (!model) throw new ModelError(`Unknown model ${ref}.`, 'not-found');
      return model;
    },
  });
  const deps = (models: Record<string, ChatModel>) => ({
    resolver: resolver(models),
    io: recordingIO(),
    toolHost: new FakeToolHost({ readFile: () => ({ content: 'x' }) }),
  });

  it('adds the usage of every model that was tried when all of them fail', async () => {
    const main = new FakeModel([readCall(usage(5, 1)), { error: new ModelError('Busy.', 'server', 503) }], {
      ref: 'main/model',
    });
    const backup = new FakeModel([readCall(usage(3, 1)), { error: new ModelError('Down.', 'network') }], {
      ref: 'backup/model',
    });
    const error = await failure(
      executeAgentRequest(request(['backup/model']), deps({ 'main/model': main, 'backup/model': backup })),
    );
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ usage: usage(8, 2), toolCalls: 2 });
    expect((error as Error).message).toMatch(
      /^No model could answer\. main\/model: Busy\. backup\/model: Down\./,
    );
  });

  it('reports the usage when a model error ends the run without fallback', async () => {
    const authError = new ModelError('Invalid API key.', 'auth', 401);
    const main = new FakeModel([readCall(usage(4, 4)), { error: authError }], { ref: 'main/model' });
    const backup = new FakeModel([say('unused')], { ref: 'backup/model' });
    const error = await failure(
      executeAgentRequest(request(['backup/model']), deps({ 'main/model': main, 'backup/model': backup })),
    );
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ message: 'Invalid API key.', usage: usage(4, 4) });
    expect((error as Error).cause).toBe(authError);
    expect(backup.calls).toHaveLength(0);
  });

  it('reports the usage when the agent runs out of turns', async () => {
    const main = new FakeModel([readCall(), readCall()], { ref: 'main/model' });
    const req = request();
    req.agent.maxTurns = 2;
    const error = await failure(executeAgentRequest(req, deps({ 'main/model': main })));
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ usage: usage(20, 4) });
  });

  it('throws the original error when no tokens were used', async () => {
    const authError = new ModelError('Invalid API key.', 'auth', 401);
    const main = new FakeModel([{ error: authError }], { ref: 'main/model' });
    await expect(executeAgentRequest(request(), deps({ 'main/model': main }))).rejects.toBe(authError);
  });
});
