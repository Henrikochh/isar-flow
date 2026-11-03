import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { HostToAgentEditor } from '@isar-flow/core';
import { AgentPanel } from '../../../src/editors/agentPanel';
import { FakeDocument, fakeMemory, fakeServices, fakeUi, memoryFile } from './fakes';

const TEXT = ['name: Reviewer', 'model: vscode/copilot/gpt-4.1', 'memory: write', ''].join('\n');
const URI = vscode.Uri.file('/w/.isarflow/agents/reviewer.agent.yaml');

function setup(options: { memory?: boolean } = {}) {
  const fake = fakeServices();
  const memory = fakeMemory();
  if (options.memory !== false) Object.assign(fake.services, { memory: memory.service });
  const { ui, api } = fakeUi();
  const posted: HostToAgentEditor[] = [];
  const panel = new AgentPanel(new FakeDocument(TEXT, URI), fake.services, api, (m) => posted.push(m));
  const memoryMessages = () =>
    posted.filter((m): m is Extract<HostToAgentEditor, { type: 'memory' }> => m.type === 'memory');
  return { ...fake, memory, ui, panel, posted, memoryMessages };
}

describe('AgentPanel project memory', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('sends the memory file of the agent after ready', async () => {
    const { panel, memory, posted, memoryMessages } = setup();
    memory.data.state = memoryFile();
    await panel.handle({ type: 'ready' });
    expect(posted.map((m) => m.type)).toEqual(['document', 'catalog', 'memory']);
    expect(memoryMessages()).toEqual([{ type: 'memory', memory: memoryFile() }]);
    expect(memory.service.stateFor).toHaveBeenCalledWith(URI);
  });

  it('sends null without a workspace folder', async () => {
    const { panel, memoryMessages } = setup();
    await panel.handle({ type: 'ready' });
    expect(memoryMessages()).toEqual([{ type: 'memory', memory: null }]);
  });

  it('sends the memory again when a memory file changes, once the webview is ready', async () => {
    const { panel, memory, memoryMessages } = setup();
    memory.emitter.fire();
    expect(memoryMessages()).toEqual([]);
    await panel.handle({ type: 'ready' });
    memory.data.state = memoryFile('/w', { bytes: 9000, overLimit: true });
    memory.emitter.fire();
    expect(memoryMessages().at(-1)).toEqual({
      type: 'memory',
      memory: memoryFile('/w', { bytes: 9000, overLimit: true }),
    });
    panel.dispose();
    memory.emitter.fire();
    expect(memoryMessages()).toHaveLength(2);
  });

  it('opens the memory file of the folder the agent uses', async () => {
    const { panel, memory } = setup();
    memory.data.state = memoryFile('/w2');
    await panel.handle({ type: 'openMemory' });
    expect(memory.service.open).toHaveBeenCalledTimes(1);
    expect(String(memory.service.open.mock.calls[0][0])).toBe('file:///w2');
  });

  it('says what to do when there is no workspace folder', async () => {
    const { panel, memory, ui } = setup();
    await panel.handle({ type: 'openMemory' });
    expect(memory.service.open).not.toHaveBeenCalled();
    expect(ui.errors).toEqual(['Open a workspace folder to use the project memory.']);
  });

  it('shows why the memory file could not be opened', async () => {
    const { panel, memory, ui } = setup();
    memory.data.state = memoryFile();
    memory.service.open.mockRejectedValueOnce(new Error('EACCES'));
    await panel.handle({ type: 'openMemory' });
    expect(ui.errors).toEqual(['Could not open the project memory: EACCES']);
  });

  it('lets Try it read and write the memory of the agent folder like a run', async () => {
    const { panel, memory, services } = setup();
    services.models.resolve.mockImplementation(async () => ({
      ref: 'vscode/copilot/gpt-4.1',
      provider: 'vscode',
      providerLabel: 'VS Code',
      id: 'copilot/gpt-4.1',
      name: 'GPT-4.1',
      capabilities: { tools: true, jsonSchema: false },
      async *chat() {
        yield { type: 'text', text: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      },
    }));
    await panel.handle({ type: 'tryIt', prompt: 'Hello', history: [] });
    await vi.waitFor(() => expect(memory.projectMemory.read).toHaveBeenCalled());
    expect(memory.service.forRun).toHaveBeenCalledWith('/w', {});
  });

  it('works without a memory service', async () => {
    const { panel, posted } = setup({ memory: false });
    await panel.handle({ type: 'ready' });
    await panel.handle({ type: 'openMemory' });
    expect(posted.map((m) => m.type)).toEqual(['document', 'catalog']);
  });
});
