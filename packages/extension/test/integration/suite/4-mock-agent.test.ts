import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, runToEnd, stepEnd, waitFor, workflowUri } from '../helpers';
import { MOCK_MODEL_ID, startMockOpenAi, type MockOpenAiServer } from '../mockOpenAi';

const MOCK_REF = `mock/${MOCK_MODEL_ID}`;

describe('Agent runs against an OpenAI-compatible endpoint', function () {
  this.timeout(120_000);

  let api: IsarFlowApi;
  let server: MockOpenAiServer;

  before(async () => {
    api = await activateApi();
    server = await startMockOpenAi();
    await vscode.workspace
      .getConfiguration('isarFlow')
      .update(
        'providers',
        [{ id: 'mock', label: 'Mock', baseUrl: server.url }],
        vscode.ConfigurationTarget.Workspace,
      );
    await api.models.refresh();
  });

  after(async () => {
    await vscode.workspace
      .getConfiguration('isarFlow')
      .update('providers', undefined, vscode.ConfigurationTarget.Workspace);
    await server?.close();
  });

  it('lists the models of the endpoint', async () => {
    const catalog = await waitFor(() => {
      const current = api.models.catalog();
      return current.models.some((m) => m.ref === MOCK_REF) && current;
    }, `${MOCK_REF} in the model catalog`);
    const provider = catalog.providers.find((p) => p.id === 'mock');
    assert.equal(provider?.status, 'ok', `Provider status: ${provider?.error ?? 'no error text'}`);
    assert.equal(provider?.modelCount, 1);
  });

  it('runs an agent block that uses a tool and returns the model text', async () => {
    const uri = await workflowUri(api, '.isarflow/workflows/mock-agent.workflow.yaml');
    const { view, events } = await runToEnd(api, uri, {});
    assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);

    const ask = stepEnd(events, 'ask');
    assert.equal(ask.status, 'success', `The block ended with: ${ask.error ?? 'no error text'}`);
    assert.equal(ask.output.text, 'The marker is isar-notes-marker-42.');
    assert.equal(ask.output.model, MOCK_REF);
    assert.equal(ask.output.turns, 2);
    assert.deepEqual(ask.output.usage, { inputTokens: 24, outputTokens: 10 });

    const logs = events.filter((e) => e.type === 'step-log' && e.stepId === 'ask');
    const streamed = logs.map((e) => (e.type === 'step-log' && e.stream === 'agent' ? e.text : '')).join('');
    assert.match(streamed, /isar-notes-marker-42/);
    assert.ok(
      logs.some((e) => e.type === 'step-log' && e.stream === 'tool' && e.text.includes('readFile')),
      'The readFile tool call was not logged.',
    );

    assert.equal(server.chatRequests.length, 2);
    const toolMessage = server.chatRequests[1].messages.find((m) => m.role === 'tool');
    assert.match(toolMessage?.content ?? '', /notes\.txt \(lines 1-2 of 2\)/);

    const show = stepEnd(events, 'show');
    assert.match(String(show.output.stdout), /agent-said-true/);
    assert.deepEqual(view.usage, { inputTokens: 24, outputTokens: 10 });
  });
});
