import { promises as fsp, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { decodeMemoryText, MEMORY_FILE, MEMORY_NOT_TEXT } from '@isar-flow/core';
import { memoryFileInside } from '@isar-flow/core/node';
import { sameUri } from '../simulation/simulationIo';

/** File access of the memory service by absolute path; injectable for tests. */
export interface MemoryFs {
  /**
   * Text of the file; undefined when it does not exist. Rejects on other read errors, and with MEMORY_NOT_TEXT when
   * the file isn't UTF-8 (a rewrite would garble it).
   */
  read(file: string): Promise<string | undefined>;
  /** Text of the file for the synchronous file list; undefined when it is missing or can't be read. */
  readSync(file: string): string | undefined;
  /** Creates the parent folders, then writes the file. */
  write(file: string, text: string): Promise<void>;
  /** Rejects when a link or junction leads the memory file of `root` outside that folder. */
  checkInside?(root: string): Promise<void>;
}

/** The part of vscode.TextDocument the service uses. */
export interface MemoryDocument {
  readonly isDirty: boolean;
  getText(): string;
  save(): Thenable<boolean>;
}

/** Open editors of memory files; injectable for tests. */
export interface MemoryDocuments {
  find(uri: vscode.Uri): MemoryDocument | undefined;
  /** Inserts `text` at the end of the open document with one undoable edit; false when that did not work. */
  append(uri: vscode.Uri, text: string): Thenable<boolean>;
  /** Text changes of any open document (unsaved edits included). */
  onDidChange(listener: (uri: vscode.Uri) => void): vscode.Disposable;
  /** Shows the file, not as a preview. */
  show(uri: vscode.Uri): Thenable<unknown>;
}

export interface MemoryFolder {
  readonly uri: vscode.Uri;
  readonly name: string;
}

/** Workspace folders and file watching; injectable for tests. */
export interface MemoryWorkspace {
  folders(): readonly MemoryFolder[];
  folderOf(uri: vscode.Uri): MemoryFolder | undefined;
  onDidChangeFolders(listener: () => void): vscode.Disposable;
  /** Watches the memory file of a folder; `onChange` runs when it is created, changed or deleted. */
  watch(folder: vscode.Uri, onChange: () => void): vscode.Disposable;
}

// TextDecoder drops a leading UTF-8 BOM. Lenient: only the sidebar preview uses it.
const decoder = new TextDecoder('utf-8');

const isNotFound = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

/** The error of MemoryFs.read for a memory file that exists but isn't UTF-8. */
export const isNotText = (error: unknown) => error instanceof Error && error.message === MEMORY_NOT_TEXT;

/** Absolute path of the memory file of a folder (or a run's worktree). */
export function memoryFilePath(root: string): string {
  return path.join(root, ...MEMORY_FILE.split('/'));
}

/** True for `.isarflow/memory.md` of any folder. */
export function isMemoryUri(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith(`/${MEMORY_FILE}`);
}

export const nodeMemoryFs: MemoryFs = {
  async read(file) {
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(file);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    return decodeMemoryText(bytes);
  },
  readSync(file) {
    try {
      return decoder.decode(readFileSync(file));
    } catch {
      return undefined;
    }
  },
  async write(file, text) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, 'utf8');
  },
  async checkInside(root) {
    await memoryFileInside(root);
  },
};

const openDocument = (uri: vscode.Uri) => vscode.workspace.textDocuments.find((doc) => sameUri(doc.uri, uri));

export const vscodeMemoryDocuments: MemoryDocuments = {
  find: openDocument,
  async append(uri, text) {
    const doc = openDocument(uri);
    if (!doc) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(doc.getText().length), text);
    return vscode.workspace.applyEdit(edit);
  },
  onDidChange: (listener) => vscode.workspace.onDidChangeTextDocument((e) => listener(e.document.uri)),
  show: (uri) => vscode.window.showTextDocument(uri, { preview: false }),
};

export const vscodeMemoryWorkspace: MemoryWorkspace = {
  folders: () => vscode.workspace.workspaceFolders ?? [],
  folderOf: (uri) => vscode.workspace.getWorkspaceFolder(uri),
  onDidChangeFolders: (listener) => vscode.workspace.onDidChangeWorkspaceFolders(() => listener()),
  watch(folder, onChange) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, MEMORY_FILE));
    return vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(onChange),
      watcher.onDidChange(onChange),
      watcher.onDidDelete(onChange),
    );
  },
};
