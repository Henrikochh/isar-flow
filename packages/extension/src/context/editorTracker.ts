import * as vscode from 'vscode';
import { isCapturableDocument } from './editorContext';

/** The text editor a run started now should see. */
export interface EditorTracker {
  /**
   * The active text editor, else the most recently active one that is still visible (a webview such as the canvas
   * makes `activeTextEditor` undefined). Isar Flow files and read-only views are skipped.
   */
  current(): vscode.TextEditor | undefined;
  dispose(): void;
}

const capturable = (editor: vscode.TextEditor | undefined): editor is vscode.TextEditor =>
  editor !== undefined && isCapturableDocument(editor.document);

export function createEditorTracker(): EditorTracker {
  const active = vscode.window.activeTextEditor;
  let recent = capturable(active) ? active : undefined;
  const subscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (capturable(editor)) recent = editor;
  });
  return {
    current() {
      const now = vscode.window.activeTextEditor;
      if (capturable(now)) return now;
      return recent && vscode.window.visibleTextEditors.includes(recent) ? recent : undefined;
    },
    dispose() {
      subscription.dispose();
      recent = undefined;
    },
  };
}
