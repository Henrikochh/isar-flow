import * as vscode from 'vscode';
import { type WorkflowSummary, type WorkflowTemplateId, workflowTemplate } from '@isar-flow/core';
import type { AgentStore, RunHistory, WorkflowStore } from '../contracts';
import { debounce } from './debounce';
import { errorMessage, listFileNames, readText, writeText } from './files';
import { baseName, fileId, IGNORE_PATH_CASE, relativeTo, slugify, uniqueName } from './paths';
import { summarizeWorkflow, usersOfAgent, type WorkflowRecord } from './workflowIndex';

export { summarizeWorkflow, usersOfAgent } from './workflowIndex';

export interface WorkflowStoreDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  agents: AgentStore;
  history: RunHistory;
}

export interface IndexedWorkflowStore extends WorkflowStore {
  /** Resolves after the first search for workflow files. */
  readonly ready: Promise<void>;
}

const WORKFLOW_GLOB = '**/*.workflow.{yaml,yml}';
const EXCLUDE_GLOB = '**/node_modules/**';
const RELOAD_DELAY_MS = 100;
const TEMPLATES_WITH_AGENTS: WorkflowTemplateId[] = ['review-loop', 'test-fix'];

const isExcluded = (uri: vscode.Uri) => uri.path.includes('/node_modules/');

const fingerprint = (records: Map<string, WorkflowRecord>) =>
  JSON.stringify([...records.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function createWorkflowStore(deps: WorkflowStoreDeps): IndexedWorkflowStore {
  return new FileWorkflowStore(deps);
}

class FileWorkflowStore implements IndexedWorkflowStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  readonly ready: Promise<void>;

  private records = new Map<string, WorkflowRecord>();
  /** Files to reload on the next flush, by URI string; `deleted` skips reading. */
  private readonly pending = new Map<string, { uri: vscode.Uri; deleted: boolean }>();
  private fullScanPending = false;
  private readonly flushSoon = debounce(() => void this.flush(), RELOAD_DELAY_MS);
  private queue: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(private readonly deps: WorkflowStoreDeps) {
    const files = vscode.workspace.createFileSystemWatcher(WORKFLOW_GLOB);
    // Deleting or moving a folder only reports the folder, not the workflow files inside it.
    const deletions = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);
    this.disposables.push(
      this.emitter,
      files,
      deletions,
      { dispose: () => this.flushSoon.dispose() },
      files.onDidCreate((uri) => this.queueFile(uri, false)),
      files.onDidChange((uri) => this.queueFile(uri, false)),
      files.onDidDelete((uri) => this.queueFile(uri, true)),
      deletions.onDidDelete((uri) => this.onDeleted(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.queueFullScan()),
      // lastRun is read from the history when listing.
      deps.history.onDidChange(() => this.emitter.fire()),
    );
    this.ready = this.enqueue(() => this.scanAll());
  }

  list(): WorkflowSummary[] {
    return [...this.records.values()]
      .map(({ summary }): WorkflowSummary => {
        const lastRun = this.deps.history.list(summary.uri)[0];
        return lastRun ? { ...summary, lastRun } : { ...summary };
      })
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
          a.relativePath.localeCompare(b.relativePath),
      );
  }

  async create(name: string, template: WorkflowTemplateId): Promise<vscode.Uri> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a folder first to create workflows.');
    if (TEMPLATES_WITH_AGENTS.includes(template)) await this.deps.agents.ensure(['coder', 'reviewer']);
    const dir = vscode.Uri.joinPath(folder.uri, '.isarflow', 'workflows');
    await vscode.workspace.fs.createDirectory(dir);
    const taken = new Set<string>();
    for (const file of await listFileNames(dir)) {
      const id = fileId(file, 'workflow');
      if (id !== undefined) taken.add(id.toLowerCase());
    }
    const uri = vscode.Uri.joinPath(dir, `${uniqueName(slugify(name, 'workflow'), taken)}.workflow.yaml`);
    await writeText(uri, workflowTemplate(template, name));
    this.deps.log.info(`Created workflow ${uri.fsPath}`);
    await this.enqueue(() => this.reload([{ uri, deleted: false }]));
    return uri;
  }

  usersOfAgent(agentId: string): string[] {
    return usersOfAgent(this.records.values(), agentId);
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private queueFile(uri: vscode.Uri, deleted: boolean): void {
    if (isExcluded(uri)) return;
    this.pending.set(uri.toString(), { uri, deleted });
    this.flushSoon.trigger();
  }

  private queueFullScan(): void {
    this.fullScanPending = true;
    this.flushSoon.trigger();
  }

  private onDeleted(uri: vscode.Uri): void {
    const prefix = `${uri.toString()}/`;
    if ([...this.records.keys()].some((key) => key.startsWith(prefix))) this.queueFullScan();
  }

  private flush(): Promise<void> {
    return this.enqueue(() => {
      const full = this.fullScanPending;
      const files = [...this.pending.values()];
      this.fullScanPending = false;
      this.pending.clear();
      return full ? this.scanAll() : this.reload(files);
    });
  }

  /** Runs index updates one at a time and fires onDidChange when one reports a change. */
  private enqueue(update: () => Promise<boolean>): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (this.disposed) return;
        if ((await update()) && !this.disposed) this.emitter.fire();
      })
      .catch((error: unknown) =>
        this.deps.log.error(`Could not update the workflow list: ${errorMessage(error)}`),
      );
    return this.queue;
  }

  private async scanAll(): Promise<boolean> {
    const uris = await vscode.workspace.findFiles(WORKFLOW_GLOB, EXCLUDE_GLOB);
    const next = new Map<string, WorkflowRecord>();
    await Promise.all(
      uris.map(async (uri) => {
        const record = await this.load(uri);
        if (record) next.set(uri.toString(), record);
      }),
    );
    const changed = fingerprint(next) !== fingerprint(this.records);
    this.records = next;
    return changed;
  }

  private async reload(files: { uri: vscode.Uri; deleted: boolean }[]): Promise<boolean> {
    let changed = false;
    for (const { uri, deleted } of files) {
      const key = uri.toString();
      const record = deleted ? undefined : await this.load(uri);
      const before = this.records.get(key);
      if (record) this.records.set(key, record);
      else this.records.delete(key);
      changed ||= JSON.stringify(before) !== JSON.stringify(record);
    }
    return changed;
  }

  private async load(uri: vscode.Uri): Promise<WorkflowRecord | undefined> {
    try {
      return summarizeWorkflow(await readText(uri), uri.toString(), this.relativePath(uri));
    } catch (error) {
      this.deps.log.warn(`Could not read workflow ${uri.fsPath}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private relativePath(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? relativeTo(folder.uri.path, uri.path, IGNORE_PATH_CASE) : baseName(uri.path);
  }
}
