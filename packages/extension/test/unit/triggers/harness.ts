import { vi } from 'vitest';
import * as vscode from 'vscode';
import type { RunReview, TriggerSummary, WorkflowSummary } from '@isar-flow/core';
import type {
  ActiveRun,
  CommandConfirmationState,
  RunFinished,
  RunRefusal,
  RunStartOptions,
  TriggerService,
} from '../../../src/contracts';
import { createTriggerService } from '../../../src/triggers/triggerService';
import type { TriggerStatusItem, TriggerUi } from '../../../src/triggers/ui';

export const ROOT = vscode.Uri.file('/ws');
export const ROOT_B = vscode.Uri.file('/other');

export const workflowUri = (id: string, root = ROOT) =>
  vscode.Uri.joinPath(root, '.isarflow', 'workflows', `${id}.workflow.yaml`).toString();

export const onSave = (...files: string[]): TriggerSummary => ({
  kind: 'save',
  label: `On save: ${files.join(', ')}`,
  files,
});
export const onChange = (...files: string[]): TriggerSummary => ({
  kind: 'change',
  label: `On change: ${files.join(', ')}`,
  files,
});
export const every = (text: string, everyMs: number | undefined): TriggerSummary => ({
  kind: 'schedule',
  label: `Every ${text}`,
  every: text,
  ...(everyMs !== undefined && { everyMs }),
});

export function summary(
  id: string,
  triggers: TriggerSummary[],
  extra: Partial<WorkflowSummary> & { root?: vscode.Uri } = {},
): WorkflowSummary {
  const { root, ...rest } = extra;
  return {
    uri: workflowUri(id, root),
    name: id.charAt(0).toUpperCase() + id.slice(1),
    relativePath: `.isarflow/workflows/${id}.workflow.yaml`,
    valid: true,
    stepCount: 1,
    triggers,
    ...rest,
  };
}

export class FakeWatcher {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidCreate = this.emitter.event;
  readonly onDidChange = this.emitter.event;
  readonly onDidDelete = this.emitter.event;
  disposed = false;
  constructor(readonly pattern: vscode.RelativePattern) {}
  fire(path: string): void {
    this.emitter.fire(vscode.Uri.file(path));
  }
  dispose(): void {
    this.disposed = true;
    this.emitter.dispose();
  }
}

export interface FakeStatusItem extends TriggerStatusItem {
  visible: boolean;
}

export interface HarnessOptions {
  workflows?: WorkflowSummary[];
  enabled?: boolean;
  trusted?: boolean;
  confirmation?: CommandConfirmationState;
  /** Leave out the run manager's onDidFinish and confirmationState (optional in the contract). */
  minimalRuns?: boolean;
}

type Listener<T> = (value: T) => unknown;

/** Runtime patches of the vscode stub: save events, watchers, configuration, trust, folders, commands. */
function patchVscode(trusted: boolean) {
  const workspace = vscode.workspace as unknown as Record<string, unknown>;
  const commands = vscode.commands as unknown as Record<string, unknown>;
  const saved = { workspace: { ...workspace }, commands: { ...commands } };
  const saves = new vscode.EventEmitter<{ uri: vscode.Uri }>();
  const configuration = new vscode.EventEmitter<{ affectsConfiguration(section: string): boolean }>();
  const trust = new vscode.EventEmitter<void>();
  const folderChanges = new vscode.EventEmitter<void>();
  const watchers: FakeWatcher[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const folders = [
    { uri: ROOT, name: 'ws', index: 0 },
    { uri: ROOT_B, name: 'other', index: 1 },
  ];
  Object.assign(workspace, {
    isTrusted: trusted,
    workspaceFolders: folders,
    onDidSaveTextDocument: (listener: Listener<{ uri: vscode.Uri }>) => saves.event(listener),
    onDidChangeConfiguration: configuration.event,
    onDidGrantWorkspaceTrust: trust.event,
    onDidChangeWorkspaceFolders: folderChanges.event,
    getWorkspaceFolder: (uri: vscode.Uri) => folders.find((f) => uri.path.startsWith(`${f.uri.path}/`)),
    createFileSystemWatcher: (pattern: vscode.RelativePattern) => {
      const watcher = new FakeWatcher(pattern);
      watchers.push(watcher);
      return watcher;
    },
  });
  Object.assign(commands, {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(id, handler);
      return { dispose: () => handlers.delete(id) };
    },
  });
  return {
    saves,
    configuration,
    trust,
    watchers,
    handlers,
    setTrusted(value: boolean) {
      workspace.isTrusted = value;
    },
    restore() {
      Object.assign(workspace, saved.workspace);
      Object.assign(commands, saved.commands);
    },
  };
}

export function createHarness(options: HarnessOptions = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T09:00:00Z'));
  const patched = patchVscode(options.trusted ?? true);
  const settings = { enabled: options.enabled ?? true };
  let workflows = options.workflows ?? [];
  const workflowsChanged = new vscode.EventEmitter<void>();
  const runsChanged = new vscode.EventEmitter<void>();
  const finished = new vscode.EventEmitter<RunFinished>();
  const reviewChanges = new vscode.EventEmitter<{ runId: string; workflowUri: string }>();
  const reviewFiles = new Map<string, string[]>();
  const live: ActiveRun[] = [];
  let runCount = 0;

  const startRun = (uri: vscode.Uri): string => {
    const runId = `run-${++runCount}`;
    live.push({
      runId,
      workflowUri: uri.toString(),
      view: {
        runId,
        workflowName: 'x',
        status: 'running',
        startedAt: Date.now(),
        inputs: {},
        usage: { inputTokens: 0, outputTokens: 0 },
        steps: {},
      },
    });
    runsChanged.fire();
    return runId;
  };

  const runs = {
    start: vi.fn(
      async (uri: vscode.Uri, _inputs?: Record<string, unknown>, _options?: RunStartOptions) =>
        startRun(uri) as string | undefined,
    ),
    active: vi.fn((uri?: string) => live.filter((run) => uri === undefined || run.workflowUri === uri)),
    onDidChangeRuns: runsChanged.event,
    onDidFinish: finished.event,
    confirmationState: vi.fn(
      async (_uri: vscode.Uri): Promise<CommandConfirmationState> => options.confirmation ?? 'approved',
    ),
    reviews: {
      onDidChange: reviewChanges.event,
      get: vi.fn(async (runId: string): Promise<RunReview | undefined> => {
        const files = reviewFiles.get(runId);
        if (!files) return undefined;
        return {
          runId,
          coverage: 'git',
          isolation: 'workspace',
          files: files.map((path) => ({
            path,
            status: 'modified',
            stepIds: [],
            decision: 'reverted',
            revertible: true,
          })),
        };
      }),
    },
  };
  const { start, active, onDidChangeRuns } = runs;

  const item: FakeStatusItem = {
    text: '',
    visible: false,
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    dispose: vi.fn(),
  };
  const ui = {
    showInfo: vi.fn(
      async (_message: string, ..._buttons: string[]): Promise<string | undefined> => undefined,
    ),
    showWarning: vi.fn(
      async (_message: string, ..._buttons: string[]): Promise<string | undefined> => undefined,
    ),
    showQuickPick: vi.fn(),
    executeCommand: vi.fn(async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined),
    createStatusItem: () => item,
  } satisfies TriggerUi;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };

  const service: TriggerService = createTriggerService(
    {
      runs: options.minimalRuns ? { start, active, onDidChangeRuns } : runs,
      workflows: { list: () => workflows, onDidChange: workflowsChanged.event },
      log: log as unknown as vscode.LogOutputChannel,
    },
    { ui, settings: { enabled: () => settings.enabled } },
  );
  const changes: string[] = [];
  service.onDidChange((event) => changes.push(event.workflowUri));

  return {
    service,
    runs,
    ui,
    item,
    log,
    changes,
    watchers: patched.watchers,
    handlers: patched.handlers,
    settings,
    /** Lets pending promises (confirmation checks, starts) settle. */
    settle: () => vi.advanceTimersByTimeAsync(0),
    elapse: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    setWorkflows(next: WorkflowSummary[]) {
      workflows = next;
      workflowsChanged.fire();
    },
    save(path: string) {
      patched.saves.fire({ uri: vscode.Uri.file(path) });
    },
    setEnabled(value: boolean) {
      settings.enabled = value;
      patched.configuration.fire({ affectsConfiguration: (s) => 'isarFlow.triggers.enabled'.startsWith(s) });
    },
    changeOtherSetting() {
      patched.configuration.fire({ affectsConfiguration: (s) => s === 'isarFlow.historyLimit' });
    },
    setTrusted: patched.setTrusted,
    grantTrust() {
      patched.setTrusted(true);
      patched.trust.fire();
    },
    /** A run started by someone else (manual, Copilot). */
    startManually: (uri: string) => startRun(vscode.Uri.parse(uri)),
    /** Ends a live run like the run manager: runs changed, then the finish event after the history save. */
    finish(runId: string, changedFiles: string[] = []) {
      const index = live.findIndex((run) => run.runId === runId);
      const [run] = live.splice(index, 1);
      runsChanged.fire();
      finished.fire({
        runId,
        workflowUri: run.workflowUri,
        workflowName: 'x',
        status: 'success',
        view: run.view,
        changedFiles,
        origin: { kind: 'manual' },
        simulated: false,
      });
    },
    /**
     * The review of a run changed (keep or revert written): `files` relative to the workspace folder. The review
     * service writes the files first and fires afterwards.
     */
    reviewChanged(runId: string, workflow: string, files: string[]) {
      reviewFiles.set(runId, files);
      reviewChanges.fire({ runId, workflowUri: workflow });
    },
    /** Ends a live run without the finish event (onDidFinish is optional). */
    endQuietly(runId: string) {
      const index = live.findIndex((run) => run.runId === runId);
      live.splice(index, 1);
      runsChanged.fire();
    },
    /** Makes the next start refuse. */
    refuseNext(refusal: RunRefusal) {
      runs.start.mockImplementationOnce(async (_uri, _inputs, startOptions) => {
        startOptions?.onRefused?.(refusal);
        return undefined;
      });
    },
    dispose() {
      service.dispose();
      patched.restore();
      vi.useRealTimers();
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;
