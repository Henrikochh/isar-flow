import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ChatModel, HostToAgentEditor, TryItEvent } from '@isar-flow/core';
import { AgentPanel } from '../../../src/editors/agentPanel';
import { DOCUMENT_CHANGED, WRITE_FAILED } from '../../../src/editors/host';
import { AsyncDocument, FakeDocument, fakeServices, fakeUi, flush } from './fakes';

const TEXT = [
  '# Strict reviewer',
  'name: Reviewer',
  'model: vscode/copilot/gpt-4.1',
  'tools: [readFile, editFile]',
  'permissions: { edits: auto }',
  '',
].join('\n');

const URI = vscode.Uri.file('/w/.isarflow/agents/reviewer.agent.yaml');

function echoModel(): ChatModel {
  return {
    ref: 'vscode/copilot/gpt-4.1',
    provider: 'vscode',
    providerLabel: 'VS Code',
    id: 'copilot/gpt-4.1',
    name: 'GPT-4.1',
    capabilities: { tools: true, jsonSchema: false },
    async *chat(messages) {
      const last = messages[messages.length - 1];
      yield { type: 'text', text: `echo: ${last.content}` };
      yield { type: 'usage', inputTokens: 3, outputTokens: 2 };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

function setup(text = TEXT) {
  return setupWith(new FakeDocument(text, URI));
}

function setupWith<D extends FakeDocument>(doc: D) {
  const fake = fakeServices();
  const { ui, api } = fakeUi();
  const posted: HostToAgentEditor[] = [];
  const panel = new AgentPanel(doc, fake.services, api, (m) => posted.push(m));
  const tryEvents = () => posted.flatMap((m): TryItEvent[] => (m.type === 'tryItEvent' ? [m.event] : []));
  return { ...fake, doc, ui, api, panel, posted, tryEvents };
}

describe('AgentPanel', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('answers ready with the document state and the catalog', async () => {
    const { panel, posted, state } = setup();
    state.identity = { id: 'reviewer', scope: 'user' };
    state.usersOfAgent.reviewer = ['.isarflow/workflows/review.workflow.yaml'];
    await panel.handle({ type: 'ready' });
    expect(posted.map((m) => m.type)).toEqual(['document', 'catalog']);
    expect(posted[0]).toMatchObject({
      type: 'document',
      doc: {
        uri: URI.toString(),
        id: 'reviewer',
        scope: 'user',
        fileName: 'reviewer.agent.yaml',
        valid: true,
        usedBy: ['.isarflow/workflows/review.workflow.yaml'],
      },
    });
    expect(posted[1]).toEqual({ type: 'catalog', catalog: state.catalog });
  });

  it('falls back to the file name when the store does not know the file', () => {
    const { panel } = setup();
    expect(panel.state()).toMatchObject({ id: 'reviewer', scope: 'workspace' });
  });

  it('warns about models no provider offers', () => {
    const { panel } = setup(TEXT.replace('vscode/copilot/gpt-4.1', 'litellm/gone'));
    expect(panel.state().diagnostics.map((d) => d.code)).toEqual(['unknown-model']);
  });

  it('debounces text changes and refreshes on store changes', async () => {
    const { panel, posted, emitters } = setup();
    panel.documentChanged();
    expect(posted).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(posted.map((m) => m.type)).toEqual(['document']);
    emitters.workflows.fire();
    emitters.agents.fire();
    emitters.models.fire();
    expect(posted.map((m) => m.type)).toEqual(['document', 'document', 'document', 'catalog', 'document']);
  });

  it('applies form updates as minimal edits', async () => {
    const { panel, doc, posted } = setup();
    await panel.handle({ type: 'update', set: { temperature: 0.3 }, unset: ['permissions'] });
    expect(doc.text).toContain('temperature: 0.3');
    expect(doc.text).not.toContain('permissions');
    expect(doc.text.startsWith('# Strict reviewer\n')).toBe(true);
    expect(doc.edits).toHaveLength(1);
    expect(posted.at(-1)).toMatchObject({ type: 'document', doc: { text: doc.text } });
  });

  it('reports update errors', async () => {
    const { panel, doc, posted } = setup('- a list\n');
    await panel.handle({ type: 'update', set: { name: 'X' } });
    expect(posted.at(-1)?.type).toBe('updateFailed');
    expect(doc.edits).toEqual([]);
  });

  it('reports refused edits', async () => {
    const { panel, doc, posted } = setup();
    doc.refuseEdits = true;
    await panel.handle({ type: 'update', set: { name: 'Critic' } });
    expect(posted.at(-1)).toEqual({ type: 'updateFailed', error: WRITE_FAILED });
  });

  it('applies form updates that arrive while an edit is on its way, one after the other', async () => {
    const doc = new AsyncDocument(TEXT, URI);
    const { panel, posted } = setupWith(doc);
    await Promise.all([
      panel.handle({ type: 'update', set: { name: 'Critic' } }),
      panel.handle({ type: 'update', set: { temperature: 0.1 } }),
    ]);
    expect(posted.filter((m) => m.type === 'updateFailed')).toEqual([]);
    expect(doc.text).toContain('name: Critic');
    expect(doc.text).toContain('temperature: 0.1');
  });

  it('says that the file changed when it keeps changing during the edit', async () => {
    const doc = new AsyncDocument(TEXT, URI);
    const { panel, posted } = setupWith(doc);
    let n = 0;
    doc.beforeApply = () => doc.type(`${doc.text}# typing ${++n}\n`);
    await panel.handle({ type: 'update', set: { name: 'Critic' } });
    expect(posted.at(-1)).toEqual({ type: 'updateFailed', error: DOCUMENT_CHANGED });
  });

  it('tries the current text of the agent with a safe tool host', async () => {
    vi.useRealTimers();
    const { panel, services, doc, tryEvents } = setup();
    services.models.resolve.mockImplementation(async () => echoModel());
    doc.text = TEXT.replace('name: Reviewer', 'name: Unsaved');
    await panel.handle({ type: 'tryIt', prompt: 'Hello', history: [] });
    await vi.waitFor(() => expect(tryEvents().at(-1)?.type).toBe('done'));
    expect(tryEvents()).toEqual([
      { type: 'text', text: 'echo: Hello' },
      { type: 'done', usage: { inputTokens: 3, outputTokens: 2 }, model: 'vscode/copilot/gpt-4.1' },
    ]);
    expect(services.tools).toHaveBeenCalledWith(expect.stringMatching(/^try-\d+$/));
  });

  it('explains why an agent cannot be tried', async () => {
    const { panel, tryEvents } = setup('name: Reviewer\n');
    await panel.handle({ type: 'tryIt', prompt: 'Hello', history: [] });
    expect(tryEvents()).toEqual([
      { type: 'error', message: 'Choose a model for this agent before trying it.' },
    ]);
  });

  it('does not run agents in Restricted Mode', async () => {
    const { panel, ui, services, tryEvents } = setup();
    ui.trusted = false;
    await panel.handle({ type: 'tryIt', prompt: 'Hello', history: [] });
    expect(tryEvents()).toEqual([
      { type: 'error', message: 'Trust this workspace to try agents. Nothing runs in Restricted Mode.' },
    ]);
    expect(services.models.resolve).not.toHaveBeenCalled();
  });

  it('stops a running try on cancel and on dispose', async () => {
    vi.useRealTimers();
    const { panel, services, tryEvents } = setup();
    services.models.resolve.mockImplementation(
      async () =>
        ({
          ...echoModel(),
          chat: (_messages, options) =>
            (async function* () {
              yield { type: 'text', text: 'Thinking' } as const;
              await new Promise((_, reject) =>
                options?.signal?.addEventListener('abort', () => reject(new Error('x'))),
              );
            })(),
        }) satisfies ChatModel,
    );
    await panel.handle({ type: 'tryIt', prompt: 'Hello', history: [] });
    await vi.waitFor(() => expect(tryEvents()).toHaveLength(1));
    await panel.handle({ type: 'cancelTryIt' });
    await vi.waitFor(() => expect(tryEvents().at(-1)).toEqual({ type: 'error', message: 'Stopped.' }));

    await panel.handle({ type: 'tryIt', prompt: 'Again', history: [] });
    await vi.waitFor(() => expect(tryEvents()).toHaveLength(3));
    panel.dispose();
    await flush();
    expect(tryEvents()).toHaveLength(3);
  });

  it('runs the remaining commands', async () => {
    const { panel, ui, doc, services } = setup();
    await panel.handle({ type: 'openYaml' });
    await panel.handle({ type: 'refreshModels' });
    await panel.handle({ type: 'addProvider' });
    expect(doc.shownRanges).toEqual([undefined]);
    expect(services.models.refresh).toHaveBeenCalled();
    expect(ui.commands).toEqual([['isarFlow.addProvider']]);
  });
});
