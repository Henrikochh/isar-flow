import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, closeAllEditors, waitFor, workflowUri, workspaceFolder } from '../helpers';

const activeInput = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;

function activeCustomEditor(uri: vscode.Uri): vscode.TabInputCustom | undefined {
  const input = activeInput();
  return input instanceof vscode.TabInputCustom && input.uri.toString() === uri.toString()
    ? input
    : undefined;
}

describe('Editors', () => {
  let api: IsarFlowApi;
  let consoleWorkflow: vscode.Uri;
  let invalidWorkflow: vscode.Uri;
  const reviewer = () => vscode.Uri.joinPath(workspaceFolder(), '.isarflow', 'agents', 'reviewer.agent.yaml');

  before(async () => {
    api = await activateApi();
    consoleWorkflow = await workflowUri(api, '.isarflow/workflows/console.workflow.yaml');
    invalidWorkflow = await workflowUri(api, '.isarflow/workflows/invalid.workflow.yaml');
  });

  afterEach(closeAllEditors);

  it('opens workflow files in the canvas', async () => {
    await vscode.commands.executeCommand('vscode.open', consoleWorkflow);
    const input = await waitFor(() => activeCustomEditor(consoleWorkflow), 'the workflow canvas tab');
    assert.equal(input.viewType, 'isarFlow.workflowEditor');
  });

  it('opens agent files in the agent editor', async () => {
    await vscode.commands.executeCommand('vscode.open', reviewer());
    const input = await waitFor(() => activeCustomEditor(reviewer()), 'the agent editor tab');
    assert.equal(input.viewType, 'isarFlow.agentEditor');
  });

  it('Open YAML shows the file as text beside the canvas', async () => {
    await vscode.commands.executeCommand('vscode.open', consoleWorkflow);
    await waitFor(() => activeCustomEditor(consoleWorkflow), 'the workflow canvas tab');
    const canvasColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

    await vscode.commands.executeCommand('isarFlow.openYaml');
    const editor = await waitFor(
      () =>
        vscode.window.activeTextEditor?.document.uri.toString() === consoleWorkflow.toString() &&
        vscode.window.activeTextEditor,
      'the YAML text editor',
    );
    assert.notEqual(editor.viewColumn, canvasColumn);
  });

  it('Open in canvas switches from the YAML text to the canvas', async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(consoleWorkflow));
    assert.ok(activeInput() instanceof vscode.TabInputText);

    await vscode.commands.executeCommand('isarFlow.openInCanvas');
    const input = await waitFor(() => activeCustomEditor(consoleWorkflow), 'the workflow canvas tab');
    assert.equal(input.viewType, 'isarFlow.workflowEditor');
  });

  it('reports problems of an invalid workflow in the Problems view', async () => {
    await vscode.workspace.openTextDocument(invalidWorkflow);
    const diagnostics = await waitFor(() => {
      const found = vscode.languages.getDiagnostics(invalidWorkflow);
      return found.length >= 2 && found;
    }, 'diagnostics for invalid.workflow.yaml');
    const messages = diagnostics.map((d) => d.message).join('\n');
    assert.match(messages, /maxIterations/);
    assert.match(messages, /nobody/);
    assert.ok(diagnostics.every((d) => d.severity === vscode.DiagnosticSeverity.Error));
  });

  it('shows Run, Simulate and Open in canvas CodeLenses on workflow YAML', async () => {
    const lenses = await waitFor(async () => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        consoleWorkflow,
      );
      return found.length > 0 && found;
    }, 'CodeLenses');
    assert.deepEqual(
      lenses.map((lens) => lens.command?.command),
      ['isarFlow.runWorkflow', 'isarFlow.simulateWorkflow', 'isarFlow.openInCanvas'],
    );
  });
});
