import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { applyWorkflowOps, type HostToWorkflowEditor, type WorkflowOp } from '@isar-flow/core';
import { PendingApprovals } from '../../../src/editors/approvals';
import { editorDocument, editorUi } from '../../../src/editors/vscodeHost';
import { WorkflowPanel } from '../../../src/editors/workflowPanel';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, workspaceFolder } from '../helpers';

const CRLF_WORKFLOW = [
  '# Canvas edits keep comments and line endings',
  'version: 1',
  'name: Line endings',
  'steps:',
  '  # builds first',
  '  - id: build',
  '    type: console',
  '    run: npm run build # inline comment',
  '',
].join('\r\n');

const INSERT: WorkflowOp[] = [
  {
    op: 'insertStep',
    target: { parentId: null, slot: 'steps', index: 1 },
    step: { id: 'console_1', type: 'console', run: 'echo done' },
  },
];
const UPDATE: WorkflowOp[] = [{ op: 'updateStep', stepId: 'build', set: { run: 'npm test' } }];

type DocumentMessage = Extract<HostToWorkflowEditor, { type: 'document' }>;

/**
 * Drives the host side of a canvas (the part behind the webview's postMessage) against a real VS Code text
 * document, so edit ops go through WorkspaceEdit exactly as they do from the webview.
 */
describe('Canvas edits', () => {
  let api: IsarFlowApi;
  let uri: vscode.Uri;

  before(async () => {
    api = await activateApi();
    uri = vscode.Uri.joinPath(workspaceFolder(), '.isarflow', 'workflows', 'crlf.workflow.yaml');
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(CRLF_WORKFLOW));
  });

  after(async () => {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  });

  it('applies two quick edits to a CRLF workflow, keeping comments and line endings', async () => {
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.eol, vscode.EndOfLine.CRLF);
    const posted: HostToWorkflowEditor[] = [];
    const approvals = new PendingApprovals(api.runs);
    const panel = new WorkflowPanel(editorDocument(document), api, editorUi, approvals, (m) =>
      posted.push(m),
    );
    const documents = () => posted.filter((m): m is DocumentMessage => m.type === 'document');
    try {
      await panel.handle({ type: 'ready' });
      assert.equal(documents()[0]?.doc.text, CRLF_WORKFLOW);

      // The webview sends each edit at once, without waiting for the host to apply the previous one.
      await Promise.all([
        panel.handle({ type: 'ops', ops: INSERT }),
        panel.handle({ type: 'ops', ops: UPDATE }),
      ]);

      const expected = applyWorkflowOps(applyWorkflowOps(CRLF_WORKFLOW, INSERT).text, UPDATE).text;
      assert.equal(document.getText(), expected, 'the document matches what the webview computes');
      assert.doesNotMatch(expected, /[^\r]\n/, 'only CRLF line endings');
      assert.match(expected, /# builds first\r\n/);
      assert.match(expected, /run: npm test # inline comment\r\n/);
      assert.match(expected, /- id: console_1\r\n/);
      assert.deepEqual(
        posted.filter((m) => m.type === 'opsFailed'),
        [],
      );
      const last = documents().at(-1);
      assert.equal(last?.doc.text, document.getText());
      assert.equal(last?.doc.valid, true);
    } finally {
      panel.dispose();
      approvals.dispose();
      await document.save();
    }
  });
});
