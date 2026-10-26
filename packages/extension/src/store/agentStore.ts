import * as vscode from 'vscode';
import {
  type AgentDefinition,
  type AgentScope,
  type AgentSummary,
  DEFAULT_AGENT_MODEL,
  defaultAgentText,
} from '@isar-flow/core';
import type { AgentRecord, AgentStore, CreateAgentOptions } from '../contracts';
import {
  type AgentIndex,
  type AgentKind,
  buildAgentIndex,
  classifyAgentPath,
  starterAgentText,
  summarizeAgent,
} from './agentIndex';
import { debounce } from './debounce';
import { errorMessage, listFileNames, readText, targetFolder, uriKey, writeText } from './files';
import { baseName, fileId, IGNORE_PATH_CASE, slugify, uniqueName } from './paths';

export { summarizeAgent } from './agentIndex';

export interface AgentStoreDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
}

export interface IndexedAgentStore extends AgentStore {
  /** Resolves after the first scan of the agent folders. */
  readonly ready: Promise<void>;
}

/**
 * Agent files and the agent folders themselves: deleting or renaming a folder only reports the folder, so
 * those events trigger a rescan too.
 */
const WORKSPACE_WATCH_GLOB = '{**/.isarflow,**/.isarflow/agents,**/.isarflow/agents/*}';
const RESCAN_DELAY_MS = 100;
/** Ids that are safe as file names. Workflows may refer to other ids, but those cannot be created. */
const FILE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** Checks an id asked for exactly (e.g. the one a workflow refers to); files differing only in case clash. */
function exactId(id: string, existing: string[]): string {
  if (!FILE_ID.test(id)) {
    throw new Error(
      `An agent file can't be named '${id}'. Refer to the agent with an id made of letters, digits, _ and -, then create it.`,
    );
  }
  const clash = existing.find((other) => other.toLowerCase() === id.toLowerCase());
  if (clash === id) throw new Error(`An agent with the id '${id}' already exists.`);
  if (clash !== undefined) {
    throw new Error(
      `An agent file '${clash}.agent.yaml' already exists. Ids are case-sensitive: refer to it as '${clash}' or pick another id.`,
    );
  }
  return id;
}

export function createAgentStore(deps: AgentStoreDeps): IndexedAgentStore {
  return new FileAgentStore(deps);
}

class FileAgentStore implements IndexedAgentStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  readonly ready: Promise<void>;

  private readonly userDir: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly rescanSoon = debounce(() => void this.rescan(), RESCAN_DELAY_MS);
  private index: AgentIndex = buildAgentIndex([]);
  private fingerprint = '';
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: AgentStoreDeps) {
    this.userDir = vscode.Uri.joinPath(deps.context.globalStorageUri, 'agents');
    const schedule = () => this.rescanSoon.trigger();
    this.watch(vscode.workspace.createFileSystemWatcher(WORKSPACE_WATCH_GLOB), schedule);
    this.disposables.push(
      this.emitter,
      { dispose: () => this.rescanSoon.dispose() },
      vscode.workspace.onDidChangeWorkspaceFolders(schedule),
      // Fallback for user agents in case the file watcher outside the workspace misses a save.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.identify(doc.uri)) schedule();
      }),
    );
    this.ready = this.watchUserDir(schedule).then(() => this.rescan());
  }

  list(): AgentSummary[] {
    return this.index.list;
  }

  definitions(): Record<string, AgentDefinition> {
    return this.index.definitions;
  }

  get(id: string): AgentRecord | undefined {
    return this.index.effective.get(id);
  }

  identify(uri: vscode.Uri): { id: string; scope: AgentScope } | undefined {
    const dirs = { workspace: this.workspaceDirs().map(uriKey), user: uriKey(this.userDir) };
    return classifyAgentPath(uriKey(uri), dirs, IGNORE_PATH_CASE);
  }

  async create(
    name: string,
    scope: AgentScope,
    kind: AgentKind = 'blank',
    options: CreateAgentOptions = {},
  ): Promise<vscode.Uri> {
    await this.ready;
    const dir = scope === 'user' ? this.userDir : this.workspaceDir(options.folder);
    if (!dir) {
      throw new Error('Open a folder first to create workspace agents, or create a user agent instead.');
    }
    // Unique across both scopes, so a new agent never shadows or is shadowed by another one.
    const existing = [...this.index.list.map((agent) => agent.id), ...(await this.idsIn(dir))];
    const taken = new Set(existing.map((id) => id.toLowerCase()));
    const id =
      options.id === undefined
        ? uniqueName(slugify(name, kind === 'blank' ? 'agent' : kind), taken)
        : exactId(options.id, existing);
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `${id}.agent.yaml`);
    await writeText(uri, starterAgentText(name, kind));
    this.deps.log.info(`Created agent '${id}' at ${uri.fsPath}`);
    await this.rescan();
    return uri;
  }

  async delete(uri: vscode.Uri): Promise<void> {
    if (!this.identify(uri)) {
      throw new Error(
        `${baseName(uri.path)} is not an agent file in an agent folder, so it was not deleted.`,
      );
    }
    await vscode.workspace.fs.delete(uri, { useTrash: true });
    this.deps.log.info(`Deleted agent file ${uri.fsPath}`);
    await this.rescan();
  }

  async ensure(ids: ('coder' | 'reviewer')[], folder?: vscode.Uri): Promise<void> {
    await this.ready;
    const dir = this.workspaceDir(folder);
    if (!dir) return;
    // Workflows reference ids case-sensitively; files in the folder are compared case-insensitively.
    const known = new Set(this.index.list.map((agent) => agent.id));
    const inDir = new Set([...(await this.idsIn(dir))].map((id) => id.toLowerCase()));
    const missing = [...new Set(ids)].filter((id) => !known.has(id) && !inDir.has(id));
    if (missing.length === 0) return;
    await vscode.workspace.fs.createDirectory(dir);
    for (const id of missing) {
      const uri = vscode.Uri.joinPath(dir, `${id}.agent.yaml`);
      await writeText(uri, defaultAgentText(id, DEFAULT_AGENT_MODEL));
      this.deps.log.info(`Created starter agent '${id}' at ${uri.fsPath}`);
    }
    await this.rescan();
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  /** Rescans all agent folders (serialized) and fires onDidChange when anything changed. */
  private rescan(): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const records = await this.scan();
        const fingerprint = JSON.stringify(records);
        if (this.disposed || fingerprint === this.fingerprint) return;
        this.fingerprint = fingerprint;
        this.index = buildAgentIndex(records);
        this.emitter.fire();
      })
      .catch((error: unknown) => this.deps.log.error(`Could not load agents: ${errorMessage(error)}`));
    return this.queue;
  }

  private async scan(): Promise<AgentRecord[]> {
    const records: AgentRecord[] = [];
    for (const dir of this.workspaceDirs()) records.push(...(await this.readDir(dir, 'workspace')));
    records.push(...(await this.readDir(this.userDir, 'user')));
    return records;
  }

  private async readDir(dir: vscode.Uri, scope: AgentScope): Promise<AgentRecord[]> {
    const records = await Promise.all(
      (await listFileNames(dir)).map(async (name) => {
        const id = fileId(name, 'agent');
        if (id === undefined) return undefined;
        const uri = vscode.Uri.joinPath(dir, name);
        try {
          return summarizeAgent(await readText(uri), uri.toString(), scope, id);
        } catch (error) {
          this.deps.log.warn(`Could not read agent file ${uri.fsPath}: ${errorMessage(error)}`);
          return undefined;
        }
      }),
    );
    return records.filter((record): record is AgentRecord => record !== undefined);
  }

  /** Ids of the agent files on disk in `dir` (the index may lag), so new files never overwrite one. */
  private async idsIn(dir: vscode.Uri): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const name of await listFileNames(dir)) {
      const id = fileId(name, 'agent');
      if (id !== undefined) ids.add(id);
    }
    return ids;
  }

  /** `.isarflow/agents` of the given workspace folder, else of the first one. */
  private workspaceDir(folder?: vscode.Uri): vscode.Uri | undefined {
    const root = targetFolder(folder);
    return root && vscode.Uri.joinPath(root, '.isarflow', 'agents');
  }

  private workspaceDirs(): vscode.Uri[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) =>
      vscode.Uri.joinPath(folder.uri, '.isarflow', 'agents'),
    );
  }

  /** The user folder must exist before it can be watched. */
  private async watchUserDir(schedule: () => void): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.userDir);
    } catch (error) {
      this.deps.log.warn(
        `Could not create the user agent folder ${this.userDir.fsPath}: ${errorMessage(error)}`,
      );
    }
    if (this.disposed) return;
    this.watch(
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.userDir, '*')),
      schedule,
    );
  }

  private watch(watcher: vscode.FileSystemWatcher, schedule: () => void): void {
    this.disposables.push(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(schedule),
    );
  }
}
