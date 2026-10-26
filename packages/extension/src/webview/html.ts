import { randomInt } from 'node:crypto';
import * as vscode from 'vscode';
import type { WebviewKind } from '@isar-flow/core';

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function createNonce(): string {
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += NONCE_CHARS.charAt(randomInt(NONCE_CHARS.length));
  return nonce;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

export interface WebviewHtmlParts {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
  view: WebviewKind;
  title: string;
}

/** Pure HTML builder (unit-tested); see renderWebviewHtml for the VS Code wiring. */
export function buildWebviewHtml({ cspSource, scriptUri, styleUri, nonce, view, title }: WebviewHtmlParts): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>${escapeHtml(title)}</title>
</head>
<body data-view="${view}">
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** HTML for an Isar Flow webview; the React bundle picks the view from `<body data-view>`. */
export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: WebviewKind, title: string): string {
  const base = vscode.Uri.joinPath(extensionUri, 'media', 'webview');
  return buildWebviewHtml({
    cspSource: webview.cspSource,
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js')).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css')).toString(),
    nonce: createNonce(),
    view,
    title,
  });
}
