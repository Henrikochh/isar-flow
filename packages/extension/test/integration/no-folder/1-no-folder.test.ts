import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { IsarFlowApi } from '../../../src/extension';
import { EXTENSION_ID, runToEnd, stepEnd } from '../helpers';

const LOOSE_WORKFLOW = `version: 1
name: Loose file
steps:
  - id: hello
    type: console
    run: echo loose-hello
`;

describe('Without a workspace folder', function () {
  this.timeout(60_000);

  let api: IsarFlowApi;
  let tempDir: string;

  before(async () => {
    assert.equal(vscode.workspace.workspaceFolders, undefined, 'This suite needs a window without a folder.');
    const extension = vscode.extensions.getExtension<IsarFlowApi>(EXTENSION_ID);
    assert.ok(extension);
    api = await extension.activate();
    await Promise.all([api.agents.ready, api.workflows.ready]);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isar-flow-loose-'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('activates with empty stores', () => {
    assert.deepEqual(api.agents.list(), []);
    assert.deepEqual(api.workflows.list(), []);
    assert.deepEqual(api.runs.active(), []);
  });

  it('opens the sidebar view', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.isarFlow');
  });

  it('refuses agent tool calls with an explanation', async () => {
    const result = await api
      .tools('run-test')
      .execute(
        { name: 'readFile', args: { path: 'notes.txt' } },
        { runId: 'run-test', stepId: 'ask', signal: new AbortController().signal, log: () => undefined },
        { edits: 'none', commands: 'none' },
      );
    assert.equal(result.isError, true);
    assert.match(result.content, /open folder/i);
  });

  it('runs a workflow file opened on its own, in the folder of the file', async () => {
    const file = path.join(tempDir, 'loose.workflow.yaml');
    fs.writeFileSync(file, LOOSE_WORKFLOW);
    const { view, events } = await runToEnd(api, vscode.Uri.file(file), {});
    assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
    assert.equal(String(stepEnd(events, 'hello').output.stdout).trim(), 'loose-hello');
  });
});
