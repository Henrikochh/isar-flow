import * as vscode from 'vscode';
import type { Range } from '@isar-flow/core';
import type { EditorDocument, EditorUi } from './host';
import { computeReplaceRange } from './textEdit';

const toVsRange = (range: Range) =>
  new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character),
  );

async function showYamlBeside(document: vscode.TextDocument, range?: Range): Promise<void> {
  // Reuse a column that already shows the YAML instead of opening a second copy.
  const visible = vscode.window.visibleTextEditors.find((editor) => editor.document === document);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
    preview: false,
  });
  if (!range) return;
  const target = toVsRange(range);
  // Cursor at the start of the block, the block itself selected.
  editor.selection = new vscode.Selection(target.end, target.start);
  editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export function editorDocument(document: vscode.TextDocument): EditorDocument {
  return {
    uri: document.uri,
    get isDirty() {
      return document.isDirty;
    },
    getText: () => document.getText(),
    save: async () => document.save(),
    replaceText: async (oldText, newText) => {
      if (document.getText() !== oldText) return false;
      const change = computeReplaceRange(oldText, newText);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, toVsRange(change), change.text);
      return vscode.workspace.applyEdit(edit);
    },
    showYaml: (range) => showYamlBeside(document, range),
  };
}

export const editorUi: EditorUi = {
  isTrusted: () => vscode.workspace.isTrusted,
  executeCommand: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
  writeClipboard: async (text) => vscode.env.clipboard.writeText(text),
  confirm: async (message, action) =>
    (await vscode.window.showInformationMessage(message, action)) === action,
  showError: (message) => void vscode.window.showErrorMessage(message),
};
