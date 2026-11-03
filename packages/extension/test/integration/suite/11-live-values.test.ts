import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, runToEnd, waitFor, workflowUri, workspaceFolder } from '../helpers';

const FLOW_PATH = '.isarflow/workflows/live-values.workflow.yaml';
const TEMPLATE = '${{ steps.greet.output }}';
// Every command works in PowerShell, cmd, bash and sh; the template sits in an env value, so its line break
// never reaches a command line.
const FLOW = `version: 1
name: Live values
steps:
  - id: greet
    type: console
    run: echo live-value-42
  - id: show
    type: console
    run: echo done
    env:
      GREETING: '${TEMPLATE}'
`;

const hoverText = (hover: vscode.Hover) =>
  hover.contents.map((part) => (typeof part === 'string' ? part : part.value)).join('\n');

describe('Live values', function () {
  this.timeout(120_000);

  let api: IsarFlowApi;
  let flowUri: vscode.Uri;

  before(async () => {
    api = await activateApi();
    const file = vscode.Uri.joinPath(workspaceFolder(), ...FLOW_PATH.split('/'));
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(FLOW));
    flowUri = await workflowUri(api, FLOW_PATH);
  });

  after(async () => {
    if (flowUri) await vscode.workspace.fs.delete(flowUri).then(undefined, () => undefined);
  });

  it('shows live values of the last run when hovering a template in the YAML', async () => {
    const { view } = await runToEnd(api, flowUri, {});
    assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);

    const document = await vscode.workspace.openTextDocument(flowUri);
    const position = document.positionAt(document.getText().indexOf(TEMPLATE) + 5);
    const markdown = await waitFor(async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        flowUri,
        position,
      );
      const text = hovers.map(hoverText).join('\n');
      return text.includes('live-value-42') && text;
    }, 'a hover with the output of greet');
    assert.match(markdown, /\*\*Value in the last run\*\* \(succeeded, just now\)/);

    // Outside a template there is no live value.
    const outside = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      flowUri,
      document.positionAt(document.getText().indexOf('echo done')),
    );
    assert.ok(!outside.map(hoverText).join('\n').includes('Value in the last run'));
  });
});
