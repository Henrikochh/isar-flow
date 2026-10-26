import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { activateApi, EXTENSION_ID } from '../helpers';

interface ContributedCommand {
  command: string;
}

describe('Activation', () => {
  it('activates and returns the API', async () => {
    const api = await activateApi();
    for (const key of ['context', 'agents', 'workflows', 'models', 'runs', 'tools', 'output'] as const) {
      assert.ok(api[key], `The API has no ${key}.`);
    }
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
  });

  it('registers every contributed command', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const contributed = (extension.packageJSON.contributes.commands as ContributedCommand[]).map(
      (c) => c.command,
    );
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(
      contributed.filter((command) => !registered.has(command)),
      [],
    );
    assert.ok(registered.has('isarFlow.internal.showRun'));
  });

  it('ships the generated JSON schemas that yamlValidation points to', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const schemas = (extension.packageJSON.contributes.yamlValidation as { url: string }[]).map((v) => v.url);
    for (const url of new Set(schemas)) {
      const file = path.join(extension.extensionPath, url);
      const schema = JSON.parse(fs.readFileSync(file, 'utf8')) as { type?: string; title?: string };
      assert.equal(schema.type, 'object', `${url} is not an object schema.`);
      assert.match(schema.title ?? '', /^Isar Flow /);
    }
  });

  it('indexes the fixture agents', async () => {
    const api = await activateApi();
    const agents = api.agents
      .list()
      .map(({ id, scope, valid, name }) => ({ id, scope, valid, name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(agents, [
      { id: 'coder', scope: 'workspace', valid: true, name: 'Coder' },
      { id: 'reviewer', scope: 'workspace', valid: true, name: 'Reviewer' },
    ]);
    assert.deepEqual(Object.keys(api.agents.definitions()).sort(), ['coder', 'reviewer']);
  });

  it('indexes the fixture workflows', async () => {
    const api = await activateApi();
    const workflows = api.workflows
      .list()
      .map(({ relativePath, name, valid }) => ({ relativePath, name, valid }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    assert.deepEqual(workflows, [
      { relativePath: '.isarflow/workflows/console.workflow.yaml', name: 'Console basics', valid: true },
      { relativePath: '.isarflow/workflows/invalid.workflow.yaml', name: 'Broken workflow', valid: false },
      { relativePath: '.isarflow/workflows/mock-agent.workflow.yaml', name: 'Mock agent', valid: true },
      { relativePath: '.isarflow/workflows/slow.workflow.yaml', name: 'Slow command', valid: true },
    ]);
    assert.deepEqual(api.workflows.usersOfAgent('reviewer'), [
      '.isarflow/workflows/mock-agent.workflow.yaml',
    ]);
  });

  it('opens the sidebar view', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.isarFlow');
  });
});
