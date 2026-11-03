import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { dirName, IGNORE_PATH_CASE } from '../store/paths';

/** File access of the simulation store; injectable for tests. */
export interface SimulationFs {
  /** Text of the file; undefined when it does not exist. Rejects on other read errors. */
  read(uri: vscode.Uri): Promise<string | undefined>;
  /** Creates the parent folders, then writes the file. */
  write(uri: vscode.Uri, text: string): Promise<void>;
  /** Synchronous, because `uriFor` picks `.sim.yml` only when that file exists. */
  exists(uri: vscode.Uri): boolean;
}

/** The part of vscode.TextDocument the store uses. */
export interface SimulationDocument {
  readonly isDirty: boolean;
  getText(): string;
  save(): Thenable<boolean>;
}

/** Open editors of simulation files; injectable for tests. */
export interface SimulationDocuments {
  /** The open text document of `uri`, if any. */
  find(uri: vscode.Uri): SimulationDocument | undefined;
  /** Replaces the whole text of the open document with one undoable edit; false when that did not work. */
  replaceAll(uri: vscode.Uri, text: string): Thenable<boolean>;
  /** Text changes of any open document (unsaved edits included). */
  onDidChange(listener: (uri: vscode.Uri) => void): vscode.Disposable;
  /** Shows the file beside the active editor, not as a preview. */
  show(uri: vscode.Uri): Thenable<unknown>;
}

export interface SimulationWatcher extends vscode.Disposable {
  readonly onDidCreate: vscode.Event<vscode.Uri>;
  readonly onDidChange: vscode.Event<vscode.Uri>;
  readonly onDidDelete: vscode.Event<vscode.Uri>;
}

// TextDecoder drops a leading UTF-8 BOM.
const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'FileNotFound' || code === 'ENOENT';
}

/** Scheme, authority and path, compared like the file system does. */
export function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  const key = (uri: vscode.Uri) => {
    const text = `${uri.scheme}://${uri.authority}${uri.path}`;
    return IGNORE_PATH_CASE ? text.toLowerCase() : text;
  };
  return key(a) === key(b);
}

export const vscodeSimulationFs: SimulationFs = {
  async read(uri) {
    try {
      return decoder.decode(await vscode.workspace.fs.readFile(uri));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  },
  async write(uri, text) {
    await vscode.workspace.fs.createDirectory(uri.with({ path: dirName(uri.path) }));
    await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
  },
  exists: (uri) => uri.scheme === 'file' && fs.existsSync(uri.fsPath),
};

const openDocument = (uri: vscode.Uri) => vscode.workspace.textDocuments.find((doc) => sameUri(doc.uri, uri));

export const vscodeSimulationDocuments: SimulationDocuments = {
  find: openDocument,
  async replaceAll(uri, text) {
    const doc = openDocument(uri);
    if (!doc) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    return vscode.workspace.applyEdit(edit);
  },
  onDidChange: (listener) => vscode.workspace.onDidChangeTextDocument((e) => listener(e.document.uri)),
  show: (uri) =>
    vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false }),
};

export const createVscodeWatcher = (glob: string): SimulationWatcher =>
  vscode.workspace.createFileSystemWatcher(glob);
