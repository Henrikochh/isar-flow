import { describe, expect, it, vi } from 'vitest';
import { executeAgentRequest, REMEMBER_TOOL } from '../../src/agent';
import type { ProjectMemory } from '../../src/agent/types';
import type { AgentRequest, StepIO } from '../../src/engine/types';
import { type ChatModel, ModelError, type ModelResolver } from '../../src/models/types';
import type { MemoryMode } from '../../src/schema/types';
import { callTools, FakeModel, say } from '../fakes/fakeModel';
import { recordingIO } from './helpers';

const SECTION_HEAD =
  '## Project memory\n\nNotes saved in .isarflow/memory.md by earlier runs. Use them as background; the task has ' +
  'priority.';
const REMEMBER_HINT =
  'Use the remember tool to save a short, durable fact about this project for later runs, one per call.';

function request(memory?: MemoryMode, agent: Partial<AgentRequest['agent']> = {}): AgentRequest {
  return {
    stepId: 'review',
    agent: {
      name: 'Reviewer',
      model: 'main/model',
      systemPrompt: 'Be strict.',
      ...(memory && { memory }),
      ...agent,
    },
    prompt: 'Review the change.',
    history: [],
    contextFiles: [],
  };
}

function resolver(models: Record<string, ChatModel | Error>): ModelResolver {
  return {
    async resolve(ref) {
      const entry = models[ref];
      if (!entry) throw new Error(`Unknown model "${ref}".`);
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

class FakeMemory implements ProjectMemory {
  readonly reads: AbortSignal[] = [];
  readonly appended: { note: string; io: StepIO }[] = [];

  constructor(
    private readonly text: string | undefined | Error,
    private readonly appendError?: Error,
  ) {}

  async read(signal: AbortSignal): Promise<string | undefined> {
    this.reads.push(signal);
    if (this.text instanceof Error) throw this.text;
    return this.text;
  }

  async append(note: string, io: StepIO): Promise<string> {
    this.appended.push({ note, io });
    if (this.appendError) throw this.appendError;
    return `- 2026-11-03: ${note}`;
  }
}

const systemOf = (model: FakeModel, call = 0) => model.calls[call].messages[0].content;

describe('executeAgentRequest: project memory', () => {
  it('reads the memory once and adds it to the system prompt (default read)', async () => {
    const memory = new FakeMemory(`# Project memory\n\n${'- a note about the project\n'.repeat(80)}`);
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    const io = recordingIO();

    await executeAgentRequest(request(), { resolver: resolver({ 'main/model': main }), io, memory });

    expect(memory.reads).toEqual([io.signal]);
    expect(systemOf(main)).toBe(
      `Be strict.\n\n${SECTION_HEAD}\n\n# Project memory\n\n${'- a note about the project\n'.repeat(80).trimEnd()}`,
    );
    expect(main.calls[0].options.tools).toBeUndefined();
    expect(io.textOf('info')).toBe('Read the project memory (2.1 KB).\n');
    expect(memory.appended).toEqual([]);
  });

  it('gives small files in bytes', async () => {
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    const io = recordingIO();
    await executeAgentRequest(request('read'), {
      resolver: resolver({ 'main/model': main }),
      io,
      memory: new FakeMemory('- Use pnpm.\n'),
    });
    expect(io.textOf('info')).toBe('Read the project memory (12 bytes).\n');
  });

  it('shows the first 8 KB of a larger file and says so', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `- note ${i} ${'x'.repeat(20)}`).join('\n');
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    const io = recordingIO();
    await executeAgentRequest(request(), {
      resolver: resolver({ 'main/model': main }),
      io,
      memory: new FakeMemory(lines),
    });
    expect(io.textOf('info')).toBe(
      'Read the project memory (15.5 KB).\nThe project memory is larger than 8 KB; the agent sees the first 8 KB.\n',
    );
    expect(systemOf(main)).toMatch(/- note \d+ x{20}\n\n\(Only the beginning of the file is shown\.\)$/);
    expect(new TextEncoder().encode(systemOf(main)).length).toBeLessThan(8192 + 400);
  });

  it('reads nothing with memory none', async () => {
    const memory = new FakeMemory('- a');
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    const io = recordingIO();
    await executeAgentRequest(request('none'), { resolver: resolver({ 'main/model': main }), io, memory });
    expect(memory.reads).toEqual([]);
    expect(systemOf(main)).toBe('Be strict.');
    expect(io.textOf('info')).toBe('');
  });

  it('adds nothing for a missing or blank file', async () => {
    for (const text of [undefined, '', ' \r\n']) {
      const main = new FakeModel([say('ok')], { ref: 'main/model' });
      const io = recordingIO();
      await executeAgentRequest(request(), {
        resolver: resolver({ 'main/model': main }),
        io,
        memory: new FakeMemory(text),
      });
      expect(systemOf(main)).toBe('Be strict.');
      expect(io.textOf('info')).toBe('');
    }
  });

  it('continues without memory when reading fails', async () => {
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    const io = recordingIO();
    const result = await executeAgentRequest(request(), {
      resolver: resolver({ 'main/model': main }),
      io,
      memory: new FakeMemory(new Error('EACCES: permission denied.')),
    });
    expect(result.text).toBe('ok');
    expect(systemOf(main)).toBe('Be strict.');
    expect(io.textOf('info')).toBe(
      'Could not read the project memory: EACCES: permission denied. Continuing without it.\n',
    );
  });

  it('stops when the run is cancelled while reading', async () => {
    const io = recordingIO();
    const memory: ProjectMemory = {
      read: async () => {
        io.controller.abort(new Error('The run was cancelled.'));
        throw new Error('read interrupted');
      },
      append: async () => '',
    };
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    await expect(
      executeAgentRequest(request(), { resolver: resolver({ 'main/model': main }), io, memory }),
    ).rejects.toThrow('The run was cancelled.');
    expect(main.calls).toEqual([]);
  });

  it('offers remember with memory write and saves through the project memory', async () => {
    const memory = new FakeMemory('- old\n');
    const main = new FakeModel(
      [callTools({ id: 'r1', name: 'remember', args: { note: 'Use pnpm.' } }), say('Done.')],
      { ref: 'main/model' },
    );
    const io = recordingIO();

    const result = await executeAgentRequest(request('write'), {
      resolver: resolver({ 'main/model': main }),
      io,
      memory,
    });

    expect(main.calls[0].options.tools).toEqual([REMEMBER_TOOL]);
    expect(systemOf(main)).toBe(`Be strict.\n\n${SECTION_HEAD}\n\n- old\n\n${REMEMBER_HINT}`);
    expect(memory.appended).toEqual([{ note: 'Use pnpm.', io }]);
    expect(result.toolCalls).toBe(1);
    expect(result.messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'r1',
      name: 'remember',
      content: 'Saved to the project memory: - 2026-11-03: Use pnpm.',
    });
  });

  it('gives the agent the reason when saving fails', async () => {
    const memory = new FakeMemory(
      undefined,
      new Error("The note contains a secret value, so it wasn't saved."),
    );
    const main = new FakeModel([callTools({ name: 'remember', args: { note: 'token abcd' } }), say('ok')], {
      ref: 'main/model',
    });
    const result = await executeAgentRequest(request('write'), {
      resolver: resolver({ 'main/model': main }),
      io: recordingIO(),
      memory,
    });
    expect(result.text).toBe('ok');
    expect(result.messages[2]).toMatchObject({
      content: "The note contains a secret value, so it wasn't saved.",
      isError: true,
    });
  });

  it('still offers remember when reading failed', async () => {
    const memory = new FakeMemory(new Error('busy'));
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    await executeAgentRequest(request('write'), {
      resolver: resolver({ 'main/model': main }),
      io: recordingIO(),
      memory,
    });
    expect(main.calls[0].options.tools).toEqual([REMEMBER_TOOL]);
    expect(systemOf(main)).toContain('No notes are saved in .isarflow/memory.md yet.');
  });

  it("says once that memory write isn't available without a project memory", async () => {
    const main = new FakeModel([callTools({ name: 'remember', args: { note: 'x' } }), say('ok')], {
      ref: 'main/model',
    });
    const io = recordingIO();
    const result = await executeAgentRequest(request('write'), {
      resolver: resolver({ 'main/model': main }),
      io,
    });
    expect(io.textOf('info')).toBe("Project memory isn't available here.\n");
    expect(main.calls[0].options.tools).toBeUndefined();
    expect(result.messages[2]).toMatchObject({
      content: 'Unknown tool "remember". This agent has no tools.',
    });
  });

  it('logs nothing without a project memory in read mode', async () => {
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    const io = recordingIO();
    await executeAgentRequest(request('read'), { resolver: resolver({ 'main/model': main }), io });
    expect(io.textOf('info')).toBe('');
  });

  it('lets fallback models reuse the memory read once', async () => {
    const memory = new FakeMemory('- Use pnpm.');
    const main = new FakeModel([{ error: new ModelError('Too many requests.', 'rate-limit') }], {
      ref: 'main/model',
    });
    const backup = new FakeModel([callTools({ name: 'remember', args: { note: 'y' } }), say('ok')], {
      ref: 'backup/model',
    });
    const result = await executeAgentRequest(request('write', { fallbackModels: ['backup/model'] }), {
      resolver: resolver({ 'main/model': main, 'backup/model': backup }),
      io: recordingIO(),
      memory,
    });
    expect(result.model).toBe('backup/model');
    expect(memory.reads).toHaveLength(1);
    expect(systemOf(backup)).toBe(systemOf(main));
    expect(systemOf(backup)).toContain('- Use pnpm.');
    expect(memory.appended.map((a) => a.note)).toEqual(['y']);
  });

  it('logs attached context files before the memory', async () => {
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    const io = recordingIO();
    await executeAgentRequest(
      { ...request(), contextFiles: ['a.ts'] },
      {
        resolver: resolver({ 'main/model': main }),
        io,
        memory: new FakeMemory('- a'),
        readContextFiles: async () => [{ path: 'a.ts', content: 'x' }],
      },
    );
    expect(io.textOf('info')).toBe('Attached 1 context file: a.ts.\nRead the project memory (3 bytes).\n');
  });

  it('uses the memory section as the system prompt of an agent without one', async () => {
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    await executeAgentRequest(request('read', { systemPrompt: undefined }), {
      resolver: resolver({ 'main/model': main }),
      io: recordingIO(),
      memory: new FakeMemory('- a'),
    });
    expect(systemOf(main)).toBe(`${SECTION_HEAD}\n\n- a`);
  });

  it('passes the signal of the block to the read', async () => {
    const read = vi.fn(async () => '- a');
    const main = new FakeModel([say('ok')], { ref: 'main/model' });
    const io = recordingIO();
    await executeAgentRequest(request(), {
      resolver: resolver({ 'main/model': main }),
      io,
      memory: { read, append: async () => '' },
    });
    expect(read).toHaveBeenCalledWith(io.signal);
  });
});
