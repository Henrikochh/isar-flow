import * as path from 'node:path';
import { vi } from 'vitest';
import * as vscode from 'vscode';
import type {
  MemoryDocument,
  MemoryDocuments,
  MemoryFolder,
  MemoryFs,
  MemoryWorkspace,
} from '../../../src/memory/memoryIo';

/** Absolute path of the memory file of a folder, as the service builds it. */
export const memoryPath = (folder: string) => path.join(folder, '.isarflow', 'memory.md');

export function fakeFs(files: Record<string, string> = {}) {
  const map = new Map(Object.entries(files));
  const fs = {
    read: vi.fn(async (file: string) => map.get(file)),
    readSync: vi.fn((file: string) => map.get(file)),
    write: vi.fn(async (file: string, text: string) => void map.set(file, text)),
    checkInside: vi.fn(async (_root: string) => undefined),
  } satisfies MemoryFs;
  return { fs, files: map, write: fs.write };
}

export class FakeDocument implements MemoryDocument {
  saves = 0;
  constructor(
    public text: string,
    public isDirty = false,
  ) {}
  getText(): string {
    return this.text;
  }
  async save(): Promise<boolean> {
    this.saves++;
    this.isDirty = false;
    return true;
  }
}

export function fakeDocuments(open: Record<string, FakeDocument> = {}) {
  const docs = new Map(Object.entries(open).map(([file, doc]) => [vscode.Uri.file(file).path, doc]));
  const changes = new vscode.EventEmitter<vscode.Uri>();
  const documents = {
    find: (uri: vscode.Uri) => docs.get(uri.path),
    append: vi.fn(async (uri: vscode.Uri, text: string) => {
      const doc = docs.get(uri.path);
      if (!doc) return false;
      doc.text += text;
      doc.isDirty = true;
      return true;
    }),
    onDidChange: (listener: (uri: vscode.Uri) => void) => changes.event(listener),
    show: vi.fn(async (_uri: vscode.Uri) => undefined),
  } satisfies MemoryDocuments;
  return { documents, docs, changes, append: documents.append, show: documents.show };
}

export function fakeWorkspace(folders: MemoryFolder[]) {
  const folderChanges = new vscode.EventEmitter<void>();
  const watchers: { folder: string; onChange: () => void; disposed: boolean }[] = [];
  const workspace = {
    folders: () => folders,
    folderOf: (uri: vscode.Uri) => folders.find((f) => uri.path.startsWith(`${f.uri.path}/`)),
    onDidChangeFolders: (listener: () => void) => folderChanges.event(listener),
    watch: (folder: vscode.Uri, onChange: () => void) => {
      const watcher = { folder: folder.path, onChange, disposed: false };
      watchers.push(watcher);
      return new vscode.Disposable(() => (watcher.disposed = true));
    },
  } satisfies MemoryWorkspace;
  return { workspace, watchers, folderChanges, folders };
}

export const folder = (fsPath: string, name: string): MemoryFolder => ({
  uri: vscode.Uri.file(fsPath),
  name,
});

export function fakeLog() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (m: string) => lines.push(`info: ${m}`),
      warn: (m: string) => lines.push(`warn: ${m}`),
      error: (m: string) => lines.push(`error: ${m}`),
    } as unknown as vscode.LogOutputChannel,
  };
}
