import * as vscode from 'vscode';
import {
  MIN_SCHEDULE_MS,
  type RunOrigin,
  type TriggerKind,
  type TriggerSummary,
  type WorkflowSummary,
  type WorkflowTriggerState,
} from '@isar-flow/core';
import type { RunFinished, RunRefusal, TriggerService, TriggerServiceDeps } from '../contracts';
import { WORKFLOW_EDITOR_VIEW_TYPE } from '../editors/host';
import { compileFiles, type FileMatcher, pathKey, relativeIn } from './matching';
import { OwnWrites } from './ownWrites';
import { dueCount, SCHEDULE_TICK_MS } from './schedule';
import {
  approvalMessage,
  ENABLED_SETTING,
  firstRunMessage,
  RUNNING_MESSAGE,
  SETTING_SECTION,
  STORM_LIMIT,
  STORM_WINDOW_MS,
  stormWarning,
  triggerStateOf,
} from './state';
import { createTriggerStatusBar, type TriggerListEntry, type TriggerStatusBar } from './statusBar';
import {
  SHOW_TRIGGERS_COMMAND,
  systemTimers,
  type TriggerServiceOptions,
  type TriggerSettings,
  type TriggerTimers,
  type TriggerUi,
  vscodeTriggerSettings,
  vscodeTriggerUi,
} from './ui';

export type { TriggerServiceOptions } from './ui';

/** Events of one workflow closer together than this start one run. */
export const DEBOUNCE_MS = 2_000;
/** After a run of the workflow, its file events are dropped for this long (its own writes)... */
export const AFTER_RUN_MS = 3_000;
/** ...and events of the files it changed for this long. */
export const CHANGED_FILES_MS = 10_000;

const OPEN_WORKFLOW = 'Open workflow';
const RESUME_TRIGGERS = 'Resume triggers';

type TriggerOrigin = Extract<RunOrigin, { kind: 'trigger' }>;
type FileTrigger = Exclude<TriggerKind, 'schedule'>;
type LastFired = NonNullable<WorkflowTriggerState['lastFired']>;

/** One workflow with triggers. */
interface Entry {
  readonly uri: string;
  readonly vsUri: vscode.Uri;
  name: string;
  valid: boolean;
  triggers: TriggerSummary[];
  /** JSON of triggers and validity, to notice changes. */
  key: string;
  folder: vscode.Uri | undefined;
  save?: FileMatcher;
  change?: FileMatcher;
  /** What the current file system watchers watch ('' = none). */
  watchKey: string;
  watchers?: vscode.Disposable;
  everyMs?: number;
  nextRunAt?: number;
  pending?: { handle: unknown; origin: TriggerOrigin };
  /** Between the decision to start and the run manager's answer. */
  starting: boolean;
  /** Times of save and change starts, for the storm guard. */
  starts: number[];
  limited: boolean;
  approval?: string;
  approvalNotified: boolean;
  inputs?: string;
  invalidAtFire: boolean;
  lastFired?: LastFired;
  ownWrites: OwnWrites;
  /** JSON of the last state sent with onDidChange. */
  stateKey: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const fileMatcher = (triggers: TriggerSummary[], kind: FileTrigger) => {
  const files = triggers.find((trigger) => trigger.kind === kind)?.files;
  return files && files.length > 0 ? compileFiles(files) : undefined;
};

const scheduleMs = (triggers: TriggerSummary[]) => {
  const everyMs = triggers.find((trigger) => trigger.kind === 'schedule')?.everyMs;
  return everyMs !== undefined && everyMs >= MIN_SCHEDULE_MS ? everyMs : undefined;
};

/**
 * Starts workflows from their `on:` triggers (save, change, schedule) while the setting is on, the workspace is
 * trusted, the workflow is valid and its commands were approved. Owns the status bar item `isarFlow.triggers` and
 * the command `isarFlow.showTriggers`.
 */
export function createTriggerService(
  deps: TriggerServiceDeps,
  options: TriggerServiceOptions = {},
): TriggerService {
  return new Triggers(deps, options);
}

class Triggers implements TriggerService {
  private readonly emitter = new vscode.EventEmitter<{ workflowUri: string }>();
  readonly onDidChange = this.emitter.event;

  private readonly now: () => number;
  private readonly timers: TriggerTimers;
  private readonly ui: TriggerUi;
  private readonly settings: TriggerSettings;
  private readonly statusBar: TriggerStatusBar;
  private readonly entries = new Map<string, Entry>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Workflows with a live run, to notice runs that ended. */
  private running = new Set<string>();
  private ticker: unknown;
  private disposed = false;

  constructor(
    private readonly deps: TriggerServiceDeps,
    options: TriggerServiceOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? systemTimers;
    this.ui = { ...vscodeTriggerUi, ...options.ui };
    this.settings = options.settings ?? vscodeTriggerSettings;
    this.statusBar = createTriggerStatusBar(this, this.ui, () => this.settings.enabled());
    const { runs, workflows } = deps;
    this.disposables.push(
      this.emitter,
      workflows.onDidChange(() => this.sync()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.sync()),
      vscode.workspace.onDidSaveTextDocument((document) => this.onSaved(document.uri)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${SETTING_SECTION}.${ENABLED_SETTING}`)) this.onGatesChanged();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.onGatesChanged()),
      runs.onDidChangeRuns(() => this.onRunsChanged()),
      ...(runs.onDidFinish ? [runs.onDidFinish((finished) => this.onFinished(finished))] : []),
      ...(runs.reviews ? [runs.reviews.onDidChange((event) => void this.onReviewChanged(event))] : []),
      vscode.commands.registerCommand(SHOW_TRIGGERS_COMMAND, () => this.statusBar.showTriggers()),
    );
    this.running = this.liveWorkflows();
    this.sync();
  }

  state(workflowUri: string): WorkflowTriggerState {
    const entry = this.entries.get(workflowUri);
    if (!entry) return { triggers: [], status: 'active' };
    return triggerStateOf({
      name: entry.name,
      triggers: entry.triggers,
      enabled: this.settings.enabled(),
      trusted: vscode.workspace.isTrusted,
      valid: entry.valid,
      invalidAtFire: entry.invalidAtFire,
      limited: entry.limited,
      approval: entry.approval,
      inputs: entry.inputs,
      nextRunAt: entry.nextRunAt,
      lastFired: entry.lastFired,
    });
  }

  list(): TriggerListEntry[] {
    return [...this.entries.values()]
      .map((entry) => ({ workflowUri: entry.uri, name: entry.name, state: this.state(entry.uri) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  resume(workflowUri: string): void {
    const entry = this.entries.get(workflowUri);
    if (!entry?.limited) return;
    entry.limited = false;
    entry.starts = [];
    this.deps.log.info(`Resumed the triggers of '${entry.name}'.`);
    this.publish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) this.dropEntry(entry);
    this.entries.clear();
    this.stopTicker();
    this.statusBar.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  /* ---------- workflows ---------- */

  private sync(): void {
    if (this.disposed) return;
    const seen = new Set<string>();
    for (const summary of this.deps.workflows.list()) {
      if (!summary.triggers?.length) continue;
      seen.add(summary.uri);
      this.update(this.entries.get(summary.uri) ?? this.add(summary), summary);
    }
    for (const entry of [...this.entries.values()]) {
      if (seen.has(entry.uri)) continue;
      this.dropEntry(entry);
      this.entries.delete(entry.uri);
      this.emitter.fire({ workflowUri: entry.uri });
    }
    this.apply();
  }

  private add(summary: WorkflowSummary): Entry {
    const entry: Entry = {
      uri: summary.uri,
      vsUri: vscode.Uri.parse(summary.uri),
      name: summary.name,
      valid: summary.valid,
      triggers: [],
      key: '',
      folder: undefined,
      watchKey: '',
      starting: false,
      starts: [],
      limited: false,
      approvalNotified: false,
      invalidAtFire: false,
      ownWrites: new OwnWrites(),
      stateKey: '',
    };
    this.entries.set(entry.uri, entry);
    return entry;
  }

  private update(entry: Entry, summary: WorkflowSummary): void {
    const triggers = summary.triggers ?? [];
    entry.name = summary.name;
    entry.folder = vscode.workspace.getWorkspaceFolder(entry.vsUri)?.uri;
    const key = JSON.stringify([triggers, summary.valid]);
    if (key === entry.key) return;
    entry.key = key;
    entry.valid = summary.valid;
    entry.triggers = triggers;
    entry.save = fileMatcher(triggers, 'save');
    entry.change = fileMatcher(triggers, 'change');
    const everyMs = scheduleMs(triggers);
    if (everyMs !== entry.everyMs) {
      entry.everyMs = everyMs;
      entry.nextRunAt = everyMs === undefined ? undefined : this.now() + everyMs;
    }
    entry.invalidAtFire = false;
    void this.checkApproval(entry);
  }

  private dropEntry(entry: Entry): void {
    this.cancelPending(entry);
    entry.watchers?.dispose();
    entry.watchers = undefined;
    entry.watchKey = '';
  }

  /** Watchers, the ticker, states and the status bar after something changed. */
  private apply(): void {
    for (const entry of this.entries.values()) this.applyWatchers(entry);
    if ([...this.entries.values()].some((entry) => entry.everyMs !== undefined)) this.startTicker();
    else this.stopTicker();
    this.publish();
  }

  /** Watchers exist only while the triggers can start runs (setting on, trusted, valid). */
  private applyWatchers(entry: Entry): void {
    const { folder, change } = entry;
    const live =
      folder !== undefined && change !== undefined && change.patterns.length > 0 && this.canFire(entry);
    const key = live ? JSON.stringify([folder.toString(), change.patterns]) : '';
    if (key === entry.watchKey) return;
    entry.watchers?.dispose();
    entry.watchers = undefined;
    entry.watchKey = key;
    if (!live) return;
    const disposables: vscode.Disposable[] = [];
    for (const pattern of change.patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
      const onEvent = (uri: vscode.Uri) => this.onFileEvent(entry, 'change', uri);
      disposables.push(
        watcher,
        watcher.onDidCreate(onEvent),
        watcher.onDidChange(onEvent),
        watcher.onDidDelete(onEvent),
      );
    }
    entry.watchers = vscode.Disposable.from(...disposables);
  }

  /** Fires onDidChange for workflows whose state changed and updates the status bar. */
  private publish(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      const key = JSON.stringify(this.state(entry.uri));
      if (key === entry.stateKey) continue;
      entry.stateKey = key;
      this.emitter.fire({ workflowUri: entry.uri });
    }
    this.statusBar.update();
  }

  /* ---------- gates ---------- */

  /** The gates checked before anything else: setting, trust, validity. */
  private canFire(entry: Entry): boolean {
    return this.settings.enabled() && vscode.workspace.isTrusted && entry.valid;
  }

  private isRunning(entry: Entry): boolean {
    return entry.starting || this.deps.runs.active(entry.uri).length > 0;
  }

  private isCurrent(entry: Entry): boolean {
    return !this.disposed && this.entries.get(entry.uri) === entry;
  }

  private onGatesChanged(): void {
    if (!this.settings.enabled()) for (const entry of this.entries.values()) this.cancelPending(entry);
    this.apply();
  }

  /** Asks the run manager whether the commands are approved (without a dialog) and updates the pause. */
  private async checkApproval(entry: Entry): Promise<void> {
    let state: string | undefined;
    try {
      state = await this.deps.runs.confirmationState?.(entry.vsUri);
    } catch (error) {
      this.deps.log.warn(`Could not check the approval of '${entry.name}': ${errorText(error)}`);
      return;
    }
    if (!this.isCurrent(entry)) return;
    if (state === 'needed') entry.approval = approvalMessage(entry.name);
    else if (state === 'never-run') entry.approval = firstRunMessage(entry.name);
    else if (state === 'approved') entry.approval = undefined;
    this.publish();
  }

  /* ---------- file events ---------- */

  private onSaved(uri: vscode.Uri): void {
    for (const entry of this.entries.values()) {
      if (uri.toString() === entry.uri) this.onOwnFileSaved(entry);
      else this.onFileEvent(entry, 'save', uri);
    }
  }

  /** The workflow file was saved: pauses found when a trigger fired may be fixed now. */
  private onOwnFileSaved(entry: Entry): void {
    entry.inputs = undefined;
    entry.invalidAtFire = false;
    this.publish();
    void this.checkApproval(entry);
  }

  private onFileEvent(entry: Entry, kind: FileTrigger, uri: vscode.Uri): void {
    const matcher = kind === 'save' ? entry.save : entry.change;
    if (!matcher || !entry.folder || entry.limited || uri.toString() === entry.uri || !this.canFire(entry))
      return;
    const file = relativeIn(entry.folder, uri);
    if (file === undefined || !matcher.matches(file)) return;
    // Its own writes: while it runs and shortly after, file events are dropped, not queued.
    if (this.isRunning(entry) || entry.ownWrites.drops(pathKey(uri.fsPath), this.now())) return;
    this.cancelPending(entry);
    const origin: TriggerOrigin = { kind: 'trigger', trigger: kind, file };
    const handle = this.timers.setTimeout(() => {
      entry.pending = undefined;
      void this.fire(entry, origin);
    }, DEBOUNCE_MS);
    entry.pending = { handle, origin };
  }

  private cancelPending(entry: Entry): void {
    if (!entry.pending) return;
    this.timers.clearTimeout(entry.pending.handle);
    entry.pending = undefined;
  }

  /* ---------- runs ---------- */

  private liveWorkflows(): Set<string> {
    return new Set(this.deps.runs.active().map((run) => run.workflowUri));
  }

  private onRunsChanged(): void {
    const now = this.now();
    const live = this.liveWorkflows();
    for (const uri of this.running) {
      if (!live.has(uri)) this.entries.get(uri)?.ownWrites.dropAll(now + AFTER_RUN_MS);
    }
    for (const uri of live) {
      const entry = this.entries.get(uri);
      // Someone started it by hand: maybe they approved its commands just now.
      if (!this.running.has(uri) && entry?.approval) void this.checkApproval(entry);
    }
    this.running = live;
  }

  private onFinished(finished: RunFinished): void {
    const entry = this.entries.get(finished.workflowUri);
    if (!entry) return;
    const now = this.now();
    entry.ownWrites.dropAll(now + AFTER_RUN_MS);
    entry.ownWrites.dropFiles(finished.changedFiles.map(pathKey), now + CHANGED_FILES_MS, now);
    if (entry.approval) void this.checkApproval(entry);
  }

  /**
   * Keep (worktree runs) and Revert in the review of one of its runs write the run's files, maybe long after the
   * run: those writes are its own, so their events are dropped like after a run. The review service writes first
   * and then fires, so a pending start caused by one of those files is cancelled as well.
   */
  private async onReviewChanged({
    runId,
    workflowUri,
  }: {
    runId: string;
    workflowUri: string;
  }): Promise<void> {
    const entry = this.entries.get(workflowUri);
    const reviews = this.deps.runs.reviews;
    if (!entry?.folder || !reviews) return;
    let review: Awaited<ReturnType<typeof reviews.get>>;
    try {
      review = await reviews.get(runId);
    } catch (error) {
      this.deps.log.warn(`Could not read the review of run ${runId}: ${errorText(error)}`);
      return;
    }
    const { folder } = entry;
    if (!review || !folder || !this.isCurrent(entry)) return;
    const keyOf = (file: string) => pathKey(vscode.Uri.joinPath(folder, file).fsPath);
    const keys = review.files.map((file) => keyOf(file.path));
    const now = this.now();
    entry.ownWrites.dropFiles(keys, now + CHANGED_FILES_MS, now);
    const pendingFile = entry.pending?.origin.file;
    if (pendingFile !== undefined && keys.includes(keyOf(pendingFile))) this.cancelPending(entry);
  }

  /** The gates in order, then the start. Never simulates or resumes. */
  private async fire(entry: Entry, origin: TriggerOrigin): Promise<void> {
    if (!this.isCurrent(entry) || !this.canFire(entry) || entry.limited) return;
    const at = this.now();
    const fired = { at, kind: origin.trigger, ...(origin.file !== undefined && { file: origin.file }) };
    if (this.isRunning(entry)) {
      entry.lastFired = { ...fired, skipped: RUNNING_MESSAGE };
      this.deps.log.info(`The ${origin.trigger} trigger of '${entry.name}' was skipped: ${RUNNING_MESSAGE}`);
      this.publish();
      return;
    }
    if (origin.trigger !== 'schedule' && this.recentStarts(entry, at) >= STORM_LIMIT) {
      this.limit(entry);
      return;
    }
    entry.starting = true;
    try {
      const confirmation = (await this.deps.runs.confirmationState?.(entry.vsUri)) ?? 'approved';
      if (!this.isCurrent(entry)) return;
      if (confirmation === 'needed' || confirmation === 'never-run') {
        const message = confirmation === 'needed' ? approvalMessage : firstRunMessage;
        this.needsApproval(entry, message(entry.name));
        return;
      }
      if (confirmation === 'invalid') {
        entry.invalidAtFire = true;
        return;
      }
      entry.approval = undefined;
      entry.invalidAtFire = false;
      // The setting or the trust may have changed while the file was read.
      if (!this.canFire(entry)) return;
      let refusal: RunRefusal | undefined;
      const runId = await this.deps.runs.start(entry.vsUri, {}, { origin, onRefused: (r) => (refusal = r) });
      if (!this.isCurrent(entry)) return;
      if (runId !== undefined) {
        if (origin.trigger !== 'schedule') entry.starts.push(at);
        entry.inputs = undefined;
        entry.lastFired = { ...fired, runId };
        // Events before the start are covered by this run.
        this.cancelPending(entry);
        this.deps.log.info(`The ${origin.trigger} trigger of '${entry.name}' started run ${runId}.`);
      } else if (refusal) {
        this.refused(entry, fired, refusal);
      }
    } catch (error) {
      this.deps.log.error(`The ${origin.trigger} trigger of '${entry.name}' failed: ${errorText(error)}`);
    } finally {
      entry.starting = false;
      this.publish();
    }
  }

  private refused(entry: Entry, fired: Omit<LastFired, 'runId' | 'skipped'>, refusal: RunRefusal): void {
    this.deps.log.info(`The ${fired.kind} trigger of '${entry.name}' did not start it: ${refusal.message}`);
    if (refusal.reason === 'inputs') entry.inputs = refusal.message;
    else if (refusal.reason === 'confirmation') this.needsApproval(entry, refusal.message);
    else entry.lastFired = { ...fired, skipped: refusal.message };
  }

  /** Paused until its commands are approved; says so once per workflow and session. */
  private needsApproval(entry: Entry, message: string): void {
    entry.approval = message;
    if (entry.approvalNotified) return;
    entry.approvalNotified = true;
    this.notify(this.ui.showInfo(message, OPEN_WORKFLOW), entry);
  }

  /* ---------- storm guard ---------- */

  private recentStarts(entry: Entry, now: number): number {
    entry.starts = entry.starts.filter((time) => now - time < STORM_WINDOW_MS);
    return entry.starts.length;
  }

  private limit(entry: Entry): void {
    entry.limited = true;
    this.cancelPending(entry);
    const message = stormWarning(entry.name);
    this.deps.log.warn(message);
    this.publish();
    this.notify(this.ui.showWarning(message, RESUME_TRIGGERS, OPEN_WORKFLOW), entry);
  }

  private notify(answer: Thenable<string | undefined>, entry: Entry): void {
    Promise.resolve(answer)
      .then(async (button) => {
        if (button === RESUME_TRIGGERS) this.resume(entry.uri);
        if (button === OPEN_WORKFLOW) {
          await this.ui.executeCommand('vscode.openWith', entry.vsUri, WORKFLOW_EDITOR_VIEW_TYPE);
        }
      })
      .catch((error: unknown) => this.deps.log.warn(`Could not open '${entry.name}': ${errorText(error)}`));
  }

  /* ---------- schedule ---------- */

  private startTicker(): void {
    if (this.ticker === undefined) this.ticker = this.timers.setInterval(() => this.tick(), SCHEDULE_TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker === undefined) return;
    this.timers.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** At most one start per workflow and tick; after a sleep the missed runs become one run. */
  private tick(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.everyMs === undefined || entry.nextRunAt === undefined) continue;
      const due = dueCount(entry.nextRunAt, entry.everyMs, now);
      if (due === 0) continue;
      const late = now - entry.nextRunAt > entry.everyMs;
      entry.nextRunAt = now + entry.everyMs;
      if (!this.canFire(entry) || entry.limited) continue;
      if (late) {
        this.deps.log.info(
          `Missed ${due} scheduled runs of '${entry.name}' while VS Code or the computer was asleep; running it once now.`,
        );
      }
      void this.fire(entry, { kind: 'trigger', trigger: 'schedule' });
    }
    this.publish();
  }
}
