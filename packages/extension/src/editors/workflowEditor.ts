import * as vscode from 'vscode';
import type { HostToWorkflowEditor, WorkflowEditorToHost } from '@isar-flow/core';
import type { Services } from '../contracts';
import { renderWebviewHtml, webviewOptions } from '../webview/html';
import { Messenger } from '../webview/messenger';
import { PendingApprovals } from './approvals';
import { fileNameOf } from './files';
import { WORKFLOW_EDITOR_VIEW_TYPE } from './host';
import { editorDocument, editorUi } from './vscodeHost';
import { WorkflowPanel } from './workflowPanel';

/** Internal command (workflowUri: string, runId: string): opens the canvas and shows that past run. */
export const SHOW_RUN_COMMAND = 'isarFlow.internal.showRun';

/** Registers the workflow canvas (custom text editor for *.workflow.y(a)ml) and the showRun command. */
export function registerWorkflowEditor(services: Services): vscode.Disposable {
  const approvals = new PendingApprovals(services.runs);
  const panels = new Map<string, WorkflowPanel>();
  const open = new Set<vscode.Disposable>();
  /** Runs to show in canvases that are being opened, by workflow URI. */
  const requestedRuns = new Map<string, string>();
  const { extensionUri } = services.context;

  const provider: vscode.CustomTextEditorProvider = {
    resolveCustomTextEditor(document, webviewPanel) {
      const key = document.uri.toString();
      const { webview } = webviewPanel;
      webview.options = webviewOptions(extensionUri);
      const messenger = new Messenger<WorkflowEditorToHost, HostToWorkflowEditor>(
        webview,
        (message) => panel.handle(message),
        services.output,
      );
      const panel = new WorkflowPanel(editorDocument(document), services, editorUi, approvals, (message) =>
        messenger.post(message),
      );
      panel.setVisible(webviewPanel.visible);
      panels.set(key, panel);
      const requested = requestedRuns.get(key);
      if (requested !== undefined) {
        requestedRuns.delete(key);
        panel.showRun(requested);
      }

      const bundle = vscode.Disposable.from(
        messenger,
        panel,
        webviewPanel.onDidChangeViewState((e) => panel.setVisible(e.webviewPanel.visible)),
        vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document.uri.toString() === key && e.contentChanges.length > 0) panel.documentChanged();
        }),
        vscode.workspace.onDidGrantWorkspaceTrust(() => panel.trustGranted()),
      );
      open.add(bundle);
      webviewPanel.onDidDispose(() => {
        if (panels.get(key) === panel) panels.delete(key);
        open.delete(bundle);
        bundle.dispose();
      });
      webview.html = renderWebviewHtml(webview, extensionUri, 'workflow', fileNameOf(document.uri));
    },
  };

  const showRun = vscode.commands.registerCommand(
    SHOW_RUN_COMMAND,
    async (workflowUri: string | vscode.Uri, runId: string) => {
      const uri = typeof workflowUri === 'string' ? vscode.Uri.parse(workflowUri) : workflowUri;
      const key = uri.toString();
      requestedRuns.set(key, runId);
      try {
        await vscode.commands.executeCommand('vscode.openWith', uri, WORKFLOW_EDITOR_VIEW_TYPE);
        // An already open canvas is only revealed, so it gets the run here.
        if (requestedRuns.get(key) === runId) panels.get(key)?.showRun(runId);
      } finally {
        if (requestedRuns.get(key) === runId) requestedRuns.delete(key);
      }
    },
  );

  return vscode.Disposable.from(
    vscode.window.registerCustomEditorProvider(WORKFLOW_EDITOR_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    showRun,
    approvals,
    {
      dispose: () => {
        for (const bundle of open) bundle.dispose();
        open.clear();
        panels.clear();
      },
    },
  );
}
