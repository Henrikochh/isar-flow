import * as vscode from 'vscode';
import { newMemoryText, type MemoryFileState } from '@isar-flow/core';
import type { MemoryService, MemoryServiceDeps } from '../contracts';
import { sameUri } from '../simulation/simulationIo';
import { debounce } from '../store/debounce';
import { IGNORE_PATH_CASE } from '../store/paths';
import {
  isMemoryUri,
  isNotText,
  memoryFilePath,
  nodeMemoryFs,
  vscodeMemoryDocuments,
  vscodeMemoryWorkspace,
  type MemoryDocuments,
  type MemoryFolder,
  type MemoryFs,
  type MemoryWorkspace,
} from './memoryIo';
import { memoryFileState } from './memoryState';
import { createProjectMemory } from './projectMemory';

export const MEMORY_DEBOUNCE_MS = 300;
const NO_FOLDER = 'Open a folder first: the project memory is .isarflow/memory.md in a workspace folder.';

export interface MemoryServiceOptions {
  fs?: MemoryFs;
  documents?: MemoryDocuments;
  workspace?: MemoryWorkspace;
  debounceMs?: number;
  /** Clock for the dates of notes. */
  now?: () => Date;
}

/**
 * `.isarflow/memory.md` of each workspace folder: states for the sidebar and the agent editor (cached until a
 * watcher, an editor or a folder change says otherwise), opening the file and per-run access for agents.
 */
export function createMemoryService(
  deps: MemoryServiceDeps,
  options: MemoryServiceOptions = {},
): MemoryService {
  const fs = options.fs ?? nodeMemoryFs;
  const documents = options.documents ?? vscodeMemoryDocuments;
  const workspace = options.workspace ?? vscodeMemoryWorkspace;
  const now = options.now ?? (() => new Date());
  const onDidChange = new vscode.EventEmitter<void>();
  const fireChange = debounce(() => onDidChange.fire(), options.debounceMs ?? MEMORY_DEBOUNCE_MS);
  const cache = new Map<string, MemoryFileState>();
  const queues = new Map<string, Promise<unknown>>();
  let disposed = false;

  const changed = () => {
    cache.clear();
    fireChange.trigger();
  };

  let watchers: vscode.Disposable[] = [];
  const watchFolders = () => {
    for (const watcher of watchers) watcher.dispose();
    watchers = workspace.folders().map((folder) => workspace.watch(folder.uri, changed));
  };
  watchFolders();
  const subscriptions = [
    workspace.onDidChangeFolders(() => {
      watchFolders();
      changed();
    }),
    documents.onDidChange((uri) => {
      if (isMemoryUri(uri)) changed();
    }),
  ];

  const stateOf = (folder: MemoryFolder): MemoryFileState => {
    const key = folder.uri.toString();
    const cached = cache.get(key);
    if (cached) return cached;
    const file = memoryFilePath(folder.uri.fsPath);
    const uri = vscode.Uri.file(file);
    const state = memoryFileState(folder, uri, documents.find(uri)?.getText() ?? fs.readSync(file));
    cache.set(key, state);
    return state;
  };

  /** Writes to the same file run one after the other; a failed write does not stop the next one. */
  const enqueue = <T>(file: string, task: () => Promise<T>): Promise<T> => {
    const key = IGNORE_PATH_CASE ? file.toLowerCase() : file;
    const done = (queues.get(key) ?? Promise.resolve()).then(task);
    const tail = done.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return done;
  };

  /** A file that isn't UTF-8 exists too: it opens, so it can be saved as UTF-8, and is never overwritten. */
  const exists = (file: string) =>
    fs.read(file).then(
      (text) => text !== undefined,
      (error: unknown) => {
        if (isNotText(error)) return true;
        throw error;
      },
    );

  const folderFor = (folderUri: vscode.Uri | undefined): MemoryFolder | undefined => {
    const folders = workspace.folders();
    if (!folderUri) return folders[0];
    return (
      folders.find((folder) => sameUri(folder.uri, folderUri)) ?? {
        uri: folderUri,
        name: folderUri.path.slice(folderUri.path.lastIndexOf('/') + 1),
      }
    );
  };

  return {
    onDidChange: onDidChange.event,

    files: () => workspace.folders().map(stateOf),

    stateFor(uri) {
      const folder = workspace.folderOf(uri) ?? workspace.folders()[0];
      return folder ? stateOf(folder) : undefined;
    },

    async open(folderUri) {
      const folder = folderFor(folderUri);
      if (!folder) throw new Error(NO_FOLDER);
      const file = memoryFilePath(folder.uri.fsPath);
      const uri = vscode.Uri.file(file);
      await enqueue(file, async () => {
        // Like runs: a file that a link or junction leads outside the folder is neither created nor shown.
        await fs.checkInside?.(folder.uri.fsPath);
        if (documents.find(uri) || (await exists(file))) return;
        await fs.write(file, newMemoryText());
        changed();
      });
      await documents.show(uri);
    },

    forRun(root, { journal, secrets }) {
      const { checkInside } = fs;
      return createProjectMemory({
        file: memoryFilePath(root),
        fs,
        documents,
        enqueue,
        now,
        ...(journal && { journal }),
        ...(secrets && { secrets }),
        ...(checkInside && { guard: () => checkInside.call(fs, root) }),
        onWrite: () => {
          if (!disposed) changed();
        },
      });
    },

    dispose() {
      disposed = true;
      fireChange.dispose();
      for (const watcher of watchers) watcher.dispose();
      for (const subscription of subscriptions) subscription.dispose();
      onDidChange.dispose();
      cache.clear();
    },
  };
}
