import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, waitFor, workspaceFolder } from '../helpers';
import { MOCK_MODEL_ID, startMockOpenAi, type MockOpenAiServer } from '../mockOpenAi';

// An own endpoint id, so the cached test result does not change how other suites resolve mock/echo-model.
const PROVIDER = 'setupmock';
const REF = `${PROVIDER}/${MOCK_MODEL_ID}`;
const FLOW_PATH = '.isarflow/workflows/setup-check.workflow.yaml';
const FLOW = `version: 1
name: Setup check
steps:
  - id: ask
    type: agent
    agent: reviewer
    model: ${REF}
    prompt: Say hello.
`;

describe('Check setup', function () {
  this.timeout(120_000);

  let api: IsarFlowApi;
  let server: MockOpenAiServer;
  let flowUri: vscode.Uri;

  before(async () => {
    api = await activateApi();
    server = await startMockOpenAi();
    await vscode.workspace
      .getConfiguration('isarFlow')
      .update(
        'providers',
        [{ id: PROVIDER, label: 'Setup mock', baseUrl: server.url }],
        vscode.ConfigurationTarget.Workspace,
      );
    flowUri = vscode.Uri.joinPath(workspaceFolder(), ...FLOW_PATH.split('/'));
    await vscode.workspace.fs.writeFile(flowUri, new TextEncoder().encode(FLOW));
    await waitFor(
      () => api.workflows.list().some((w) => w.relativePath === FLOW_PATH),
      `${FLOW_PATH} in the workflow index`,
    );
  });

  after(async () => {
    api?.setupCheck.dismiss();
    await vscode.workspace
      .getConfiguration('isarFlow')
      .update('providers', undefined, vscode.ConfigurationTarget.Workspace);
    if (flowUri) await vscode.workspace.fs.delete(flowUri).then(undefined, () => undefined);
    await server?.close();
  });

  it('reports the endpoint and tests the model a workflow uses', async () => {
    await vscode.commands.executeCommand('isarFlow.checkSetup');

    const report = api.setupCheck.current();
    assert.ok(report?.finishedAt, 'The setup check did not finish.');
    const endpoint = report.items.find((item) => item.id === `endpoint:${PROVIDER}`);
    assert.deepEqual(
      endpoint && { status: endpoint.status, message: endpoint.message, label: endpoint.label },
      { status: 'ok', message: 'Reachable, 1 model', label: 'Setup mock' },
    );

    // The mock server answers without native tool calls, so the model needs text tool mode.
    const model = report.items.find((item) => item.id === `model:${REF}`);
    assert.ok(model, `No item for ${REF}: ${JSON.stringify(report.items)}`);
    assert.equal(model.status, 'warning', model.message);
    assert.equal(model.message, 'Needs text tool mode. In Reviewer, set Tool calls to Text in the prompt.');
    assert.deepEqual(model.usedBy, [FLOW_PATH, 'reviewer']);
    assert.equal(model.fix?.message.type, 'openAgent');
    assert.ok(server.chatRequests.length >= 2, 'The model was not asked for a tool call and a JSON answer.');
    assert.ok(
      server.chatRequests[0].tools?.some((tool) => tool.function?.name === 'get_weather'),
      'The first test request did not offer the get_weather tool.',
    );
    assert.equal(api.models.catalog().probes?.[REF]?.outcome, 'text');
  });

  it('dismisses the report', () => {
    api.setupCheck.dismiss();
    assert.equal(api.setupCheck.current(), undefined);
  });
});
