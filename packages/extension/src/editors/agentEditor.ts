import * as vscode from 'vscode';
import type { AgentEditorToHost, HostToAgentEditor } from '@isar-flow/core';
import type { Services } from '../contracts';
import { renderWebviewHtml, webviewOptions } from '../webview/html';
import { Messenger } from '../webview/messenger';
import { AgentPanel } from './agentPanel';
import { fileNameOf } from './files';
import { AGENT_EDITOR_VIEW_TYPE } from './host';
import { editorDocument, editorUi } from './vscodeHost';

/** Registers the agent editor (custom text editor for *.agent.y(a)ml): form plus Try it chat. */
export function registerAgentEditor(services: Services): vscode.Disposable {
  const open = new Set<vscode.Disposable>();
  const { extensionUri } = services.context;

  const provider: vscode.CustomTextEditorProvider = {
    resolveCustomTextEditor(document, webviewPanel) {
      const key = document.uri.toString();
      const { webview } = webviewPanel;
      webview.options = webviewOptions(extensionUri);
      const messenger = new Messenger<AgentEditorToHost, HostToAgentEditor>(
        webview,
        (message) => panel.handle(message),
        services.output,
      );
      const panel = new AgentPanel(editorDocument(document), services, editorUi, (message) =>
        messenger.post(message),
      );

      const bundle = vscode.Disposable.from(
        messenger,
        panel,
        vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document.uri.toString() === key && e.contentChanges.length > 0) panel.documentChanged();
        }),
      );
      open.add(bundle);
      webviewPanel.onDidDispose(() => {
        open.delete(bundle);
        bundle.dispose();
      });
      webview.html = renderWebviewHtml(webview, extensionUri, 'agent', fileNameOf(document.uri));
    },
  };

  return vscode.Disposable.from(
    // The Try it transcript lives in the webview, so it is kept while the tab is hidden.
    vscode.window.registerCustomEditorProvider(AGENT_EDITOR_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    {
      dispose: () => {
        for (const bundle of open) bundle.dispose();
        open.clear();
      },
    },
  );
}
