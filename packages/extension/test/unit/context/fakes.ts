import * as vscode from 'vscode';

export interface FakeSelection {
  /** [line, character] of the start and end. */
  from: [number, number];
  to: [number, number];
  /** Cursor end of the selection (default: `to`). */
  active?: [number, number];
}

/** A text editor over `text` with the given selections (the first one is the primary selection). */
export function fakeEditor(
  uri: vscode.Uri,
  text: string,
  selections: FakeSelection[] = [{ from: [0, 0], to: [0, 0] }],
  languageId = 'typescript',
): vscode.TextEditor {
  const lines = text.split('\n');
  const offset = (p: vscode.Position) =>
    lines.slice(0, p.line).reduce((sum, line) => sum + line.length + 1, 0) + p.character;
  const made = selections.map((s) => {
    const start = new vscode.Position(...s.from);
    const end = new vscode.Position(...s.to);
    const active = new vscode.Position(...(s.active ?? s.to));
    return {
      start,
      end,
      active,
      anchor: start,
      isEmpty: start.line === end.line && start.character === end.character,
    } as unknown as vscode.Selection;
  });
  const document = {
    uri,
    languageId,
    isUntitled: uri.scheme === 'untitled',
    getText: (range?: vscode.Range) => (range ? text.slice(offset(range.start), offset(range.end)) : text),
  } as unknown as vscode.TextDocument;
  return { document, selection: made[0], selections: made } as unknown as vscode.TextEditor;
}

type Listener<T> = (value: T) => unknown;

/** Patches the stub's window with an active editor, visible editors and a firing onDidChangeActiveTextEditor. */
export function patchWindow(active: vscode.TextEditor | undefined, visible: vscode.TextEditor[] = []) {
  const listeners: Listener<vscode.TextEditor | undefined>[] = [];
  const window = vscode.window as unknown as {
    activeTextEditor: vscode.TextEditor | undefined;
    visibleTextEditors: vscode.TextEditor[];
    onDidChangeActiveTextEditor: (listener: Listener<vscode.TextEditor | undefined>) => vscode.Disposable;
  };
  const saved = { ...window };
  Object.assign(window, {
    activeTextEditor: active,
    visibleTextEditors: visible,
    onDidChangeActiveTextEditor: (listener: Listener<vscode.TextEditor | undefined>) => {
      listeners.push(listener);
      return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
    },
  });
  return {
    listeners,
    /** Makes `editor` active (undefined: a webview got focus) and fires the event. */
    activate(editor: vscode.TextEditor | undefined, visibleNow?: vscode.TextEditor[]) {
      window.activeTextEditor = editor;
      if (visibleNow) window.visibleTextEditors = visibleNow;
      for (const listener of [...listeners]) listener(editor);
    },
    setVisible(editors: vscode.TextEditor[]) {
      window.visibleTextEditors = editors;
    },
    restore() {
      Object.assign(window, saved);
    },
  };
}
