import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { StepIO } from '@isar-flow/core';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, workspaceFolder } from '../helpers';

const io = (): StepIO => ({
  runId: 'run-root',
  stepId: 'ask',
  signal: new AbortController().signal,
  log: () => undefined,
});

describe('Host actions', () => {
  let api: IsarFlowApi;

  before(async () => {
    api = await activateApi();
  });

  it('removes a model endpoint the sidebar confirmed without asking again', async () => {
    const config = () => vscode.workspace.getConfiguration('isarFlow');
    const entry = {
      id: 'gone',
      label: 'Gone',
      baseUrl: 'http://127.0.0.1:9',
      discoverModels: false,
      models: ['m'],
    };
    await config().update('providers', [entry], vscode.ConfigurationTarget.Workspace);
    try {
      // A confirmation dialog would never be answered here, so the command would not return.
      await vscode.commands.executeCommand('isarFlow.removeProvider', 'gone', { confirmed: true });
      assert.deepEqual(config().inspect<unknown[]>('providers')?.workspaceValue, []);
    } finally {
      await config().update('providers', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('starts commands without the Electron variables of the extension host', async function () {
    this.timeout(60_000);
    const host = api.tools('run-env');
    const result = await host.execute(
      {
        name: 'runCommand',
        args: { command: 'node -e "console.log(process.env.ELECTRON_RUN_AS_NODE || \'unset\')"' },
      },
      io(),
      { edits: 'none', commands: 'auto' },
    );
    assert.equal(result.isError, undefined, result.content);
    assert.match(result.content, /^exit code 0\nunset\s*$/);
  });

  it('gives agent tools the folder they are created for', async () => {
    const root = path.join(workspaceFolder().fsPath, 'nested-root');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'inner.txt'), 'nested-root-marker\n');
    try {
      const host = api.tools('run-root', root);
      const permissions = { edits: 'none', commands: 'none' } as const;
      const inner = await host.execute({ name: 'readFile', args: { path: 'inner.txt' } }, io(), permissions);
      assert.equal(inner.isError, undefined, inner.content);
      assert.match(inner.content, /nested-root-marker/);

      const outside = await host.execute(
        { name: 'readFile', args: { path: '../notes.txt' } },
        io(),
        permissions,
      );
      assert.equal(outside.isError, true);

      const fallback = await api
        .tools('run-root')
        .execute({ name: 'readFile', args: { path: 'notes.txt' } }, io(), permissions);
      assert.equal(fallback.isError, undefined, fallback.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
