/**
 * In-memory workspace for store tests: installs a fake file system, workspace folders and capturable file
 * watchers into the vscode stub. Paths are URI paths ('/ws/.isarflow/agents/coder.agent.yaml').
 */
import * as vscode from 'vscode';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

export class MemFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(['/']);
  readonly deleted: { path: string; useTrash?: boolean }[] = [];

  add(path: string, text: string): this {
    this.mkdirp(parentOf(path));
    this.files.set(path, text);
    return this;
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  mkdirp(path: string): void {
    for (let p = path; p !== '/' && p !== ''; p = parentOf(p)) this.dirs.add(p);
  }

  readonly api = {
    readFile: async (uri: vscode.Uri): Promise<Uint8Array> => {
      const text = this.files.get(uri.path);
      if (text === undefined) throw new Error(`FileNotFound: ${uri.path}`);
      return encoder.encode(text);
    },
    writeFile: async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
      if (!this.dirs.has(parentOf(uri.path))) throw new Error(`FileNotFound (parent): ${uri.path}`);
      this.files.set(uri.path, decoder.decode(content));
    },
    readDirectory: async (uri: vscode.Uri): Promise<[string, vscode.FileType][]> => {
      if (!this.dirs.has(uri.path)) throw new Error(`FileNotFound: ${uri.path}`);
      const entries: [string, vscode.FileType][] = [];
      for (const path of this.files.keys()) {
        if (parentOf(path) === uri.path)
          entries.push([path.slice(uri.path.length + 1), vscode.FileType.File]);
      }
      for (const dir of this.dirs) {
        if (dir !== uri.path && parentOf(dir) === uri.path) {
          entries.push([dir.slice(uri.path.length + 1), vscode.FileType.Directory]);
        }
      }
      return entries;
    },
    createDirectory: async (uri: vscode.Uri): Promise<void> => this.mkdirp(uri.path),
    delete: async (uri: vscode.Uri, options?: { useTrash?: boolean }): Promise<void> => {
      if (!this.files.delete(uri.path)) throw new Error(`FileNotFound: ${uri.path}`);
      this.deleted.push({ path: uri.path, useTrash: options?.useTrash });
    },
  };
}

export class FakeWatcher {
  readonly create = new vscode.EventEmitter<vscode.Uri>();
  readonly change = new vscode.EventEmitter<vscode.Uri>();
  readonly delete = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidCreate = this.create.event;
  readonly onDidChange = this.change.event;
  readonly onDidDelete = this.delete.event;
  disposed = false;
  constructor(
    readonly pattern: unknown,
    readonly ignore: [boolean, boolean, boolean],
  ) {}
  dispose(): void {
    this.disposed = true;
  }
}

export interface FakeWorkspace {
  fs: MemFs;
  watchers: FakeWatcher[];
  folders: vscode.Uri[];
  foldersChanged: vscode.EventEmitter<void>;
}

/** Installs a fresh fake workspace with the given folder paths (none → no folder open). */
export function installFakeWorkspace(folderPaths: string[]): FakeWorkspace {
  const fs = new MemFs();
  const watchers: FakeWatcher[] = [];
  const folders = folderPaths.map((p) => vscode.Uri.file(p));
  for (const p of folderPaths) fs.mkdirp(p);
  const foldersChanged = new vscode.EventEmitter<void>();
  const workspaceFolders = folders.map((uri, index) => ({ uri, name: uri.path.slice(1), index }));
  Object.assign(vscode.workspace.fs, fs.api);
  Object.assign(vscode.workspace, {
    workspaceFolders: workspaceFolders.length ? workspaceFolders : undefined,
    onDidChangeWorkspaceFolders: foldersChanged.event,
    getWorkspaceFolder: (uri: vscode.Uri) =>
      workspaceFolders.find((f) => uri.path.startsWith(`${f.uri.path}/`)),
    createFileSystemWatcher: (pattern: unknown, ic = false, ich = false, id = false) => {
      const watcher = new FakeWatcher(pattern, [ic, ich, id]);
      watchers.push(watcher);
      return watcher;
    },
    findFiles: async () =>
      [...fs.files.keys()]
        .filter((p) => /\.workflow\.ya?ml$/.test(p) && !p.includes('/node_modules/'))
        .filter((p) => folderPaths.some((f) => p.startsWith(`${f}/`)))
        .map((p) => vscode.Uri.file(p)),
  });
  return { fs, watchers, folders, foldersChanged };
}

export function fakeContext(): vscode.ExtensionContext {
  const state = new Map<string, unknown>();
  return {
    globalStorageUri: vscode.Uri.file('/global'),
    extensionUri: vscode.Uri.file('/ext'),
    workspaceState: {
      get: (key: string, fallback?: unknown) => (state.has(key) ? state.get(key) : fallback),
      update: async (key: string, value: unknown) => void state.set(key, value),
      keys: () => [...state.keys()],
    },
  } as unknown as vscode.ExtensionContext;
}

export interface FakeLog {
  log: vscode.LogOutputChannel;
  lines: string[];
}

export function fakeLog(): FakeLog {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string | Error): void =>
      void lines.push(`${level}: ${message instanceof Error ? message.message : message}`);
  const log = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    trace: record('trace'),
  } as unknown as vscode.LogOutputChannel;
  return { log, lines };
}
