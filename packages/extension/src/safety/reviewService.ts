import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { RunHistory, ReviewService } from '../contracts';
import { resolveInWorkspaceReal } from '../tools/pathGuard';
import { openEditJournal, type RunEditJournal } from './editJournal';
import type { GitChange, GitSnapshots } from './gitSnapshots';
import { buildReviewFiles } from './reviewFiles';
import {
  countsOf,
  readReviewState,
  reviewDir,
  runSnapshotOf,
  toRunReview,
  workspaceSnapshotOf,
  writeReviewState,
  type ReviewFileState,
  type ReviewState,
} from './reviewState';
import { isRelativePath, isRunId, parseSnapshotUri, snapshotUri } from './snapshotUri';
import {
  errorText,
  exists,
  hashOf,
  isBinary,
  plural,
  readIfFile,
  resolveInside,
  sameBytes,
  type SafetyLog,
} from './util';

/** Changes to workspace files made by keep and revert; the VS Code version keeps open editors in sync. */
export interface WorkspaceFiles {
  /** The text of an open editor with unsaved changes, else the file's bytes; undefined when it does not exist. */
  current(absPath: string): Promise<Uint8Array | undefined>;
  /** Creates (with parent folders) or overwrites a file. */
  write(absPath: string, bytes: Uint8Array): Promise<void>;
  delete(absPath: string): Promise<void>;
}

export interface ReviewUi {
  /** Modal warning; resolves to the chosen button (undefined = Cancel). */
  ask(message: string, detail: string | undefined, buttons: string[]): Promise<string | undefined>;
  showInfo(message: string, ...buttons: string[]): Promise<string | undefined>;
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
}

export interface ReviewServiceOptions {
  storageDir: string;
  snapshots: GitSnapshots;
  history: RunHistory;
  files: WorkspaceFiles;
  ui: ReviewUi;
  log: SafetyLog;
}

/** The review service plus what the run safety needs to manage a run's review. */
export interface RunReviewService extends ReviewService {
  /** Registers a run at its start (saved, so a run interrupted by closing VS Code is found later). */
  track(state: ReviewState): Promise<RunEditJournal>;
  /** Builds the review at the run end (after snapshot); resolves with the number of changed files. */
  complete(runId: string, options?: { skipSnapshot?: boolean; overlapping?: boolean }): Promise<number>;
  /** Stores the counts in the history (after the run was saved there) and tells listeners. */
  publish(runId: string): Promise<void>;
  /** Drops a run's snapshots, journal and worktree (e.g. its setup failed). */
  discard(runId: string): Promise<void>;
  /** Removes the reviews of runs that left the history. */
  prune(runIds: string[]): Promise<void>;
  /** Removes a run's worktree and marks it as no longer available. */
  removeWorktree(runId: string): Promise<void>;
  isLive(runId: string): boolean;
  state(runId: string): Promise<ReviewState | undefined>;
  /** Run ids with a saved review. */
  storedRunIds(): Promise<string[]>;
  dispose(): void;
}

const MAX_NAMED_FILES = 5;
const decoder = new TextDecoder();

function namesOf(files: ReviewFileState[]): string {
  const names = files.slice(0, MAX_NAMED_FILES).map((file) => file.path);
  const more = files.length - names.length;
  return more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', ');
}

/** Equal content, ignoring CRLF / LF differences of text files (git may check files out either way). */
function sameContent(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (isBinary(a) || isBinary(b)) return sameBytes(a, b);
  return decoder.decode(a).replace(/\r\n/g, '\n') === decoder.decode(b).replace(/\r\n/g, '\n');
}

const notRevertible = (file: string) =>
  `${file} can't be reverted because its state before the run is unknown. Keep it, or restore it by hand.`;

export function createReviewService(options: ReviewServiceOptions): RunReviewService {
  const { storageDir, snapshots, history, files, ui, log } = options;
  const onDidChange = new vscode.EventEmitter<{ runId: string; workflowUri: string }>();
  const states = new Map<string, ReviewState>();
  const journals = new Map<string, RunEditJournal>();
  const live = new Set<string>();
  const busy = new Set<string>();
  const queues = new Map<string, Promise<unknown>>();
  let disposed = false;

  const fire = (state: ReviewState) => {
    if (!disposed) onDidChange.fire({ runId: state.runId, workflowUri: state.workflowUri });
  };

  /** One operation per run at a time (decisions, lazy snapshots, pruning). */
  function serialize<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const result = (queues.get(runId) ?? Promise.resolve()).then(task, task);
    const tail = result.catch(() => undefined);
    queues.set(runId, tail);
    void tail.then(() => {
      if (queues.get(runId) === tail) queues.delete(runId);
    });
    return result;
  }

  async function load(runId: string): Promise<ReviewState | undefined> {
    const cached = states.get(runId);
    if (cached) return cached;
    const stored = await readReviewState(storageDir, runId);
    if (stored && !states.has(runId)) states.set(runId, stored);
    return states.get(runId);
  }

  async function save(state: ReviewState): Promise<void> {
    try {
      await writeReviewState(storageDir, state);
    } catch (error) {
      log.warn(`Could not save the review of run ${state.runId}: ${errorText(error)}`);
    }
  }

  function journalOf(state: ReviewState): RunEditJournal {
    let journal = journals.get(state.runId);
    if (!journal) {
      const useGit = state.coverage === 'git' || state.repoTop !== undefined;
      journal = openEditJournal({
        runId: state.runId,
        root: state.runRoot,
        dir: reviewDir(storageDir, state.runId),
        log,
        ...(useGit && {
          storeLarge: (absPath: string) => snapshots.storeBlob(state.root, absPath),
          readLarge: (id: string) => snapshots.readBlob(state.root, id),
        }),
      });
      journals.set(state.runId, journal);
    }
    return journal;
  }

  async function publishCounts(state: ReviewState): Promise<void> {
    if (state.files.length === 0) return;
    try {
      await history.setReview?.(state.runId, countsOf(state));
    } catch (error) {
      log.warn(`Could not store the review counts of run ${state.runId}: ${errorText(error)}`);
    }
    fire(state);
  }

  /** Removes everything a run left: snapshot refs, worktree, journal and review files. */
  async function drop(state: ReviewState): Promise<void> {
    states.delete(state.runId);
    journals.delete(state.runId);
    busy.delete(state.runId);
    await snapshots.prune(state.root, [state.runId]);
    if (state.worktreePath && state.worktreeAvailable) {
      await snapshots.removeWorktree(state.root, state.worktreePath).catch((error: unknown) => {
        log.warn(`Could not remove the worktree ${state.worktreePath}: ${errorText(error)}`);
      });
    }
    await fs.rm(reviewDir(storageDir, state.runId), { recursive: true, force: true, maxRetries: 3 });
  }

  async function finalize(state: ReviewState): Promise<void> {
    const journal = journalOf(state);
    await journal.seal();
    let changes: GitChange[] = [];
    if (state.coverage === 'git' && state.before) {
      const result = await snapshots.finish(runSnapshotOf(state));
      state.coverage = result.snapshot.coverage;
      if (result.snapshot.after) state.after = result.snapshot.after;
      changes = result.changes;
    }
    state.files = await buildReviewFiles(state, changes, journal);
    state.finished = true;
    if (state.files.length === 0) await drop(state);
    else await save(state);
  }

  /** The state of a finished run; takes the after snapshot first when the run was interrupted. */
  async function ready(runId: string): Promise<ReviewState | undefined> {
    if (!isRunId(runId) || live.has(runId)) return undefined;
    const state = await load(runId);
    if (!state || state.finished) return state;
    return serialize(runId, async () => {
      if (state.finished || states.get(runId) !== state) return states.get(runId);
      await finalize(state);
      await publishCounts(state);
      return states.get(runId);
    });
  }

  async function withBusy(state: ReviewState, task: () => Promise<void>): Promise<void> {
    busy.add(state.runId);
    fire(state);
    try {
      await task();
    } finally {
      busy.delete(state.runId);
    }
  }

  /**
   * The file before the run. The journal has the exact bytes, but from the first agent write, which may come
   * after a command changed the file; so a git snapshot with other content wins. Unless the journal kept an
   * editor's unsaved text, which the snapshot of the disk does not have.
   */
  async function beforeBytes(state: ReviewState, file: string): Promise<Uint8Array | undefined> {
    const journal = journalOf(state);
    const original = (await journal.original(file)) ?? undefined;
    if (journal.hadUnsavedChanges(file) || state.coverage !== 'git' || !state.before) return original;
    const snapshot = await snapshots.read(workspaceSnapshotOf(state), 'before', file);
    if (snapshot === undefined) return original;
    return original !== undefined && sameContent(original, snapshot) ? original : snapshot;
  }

  /** `rel` in `root`, refusing paths that leave it, also through a link or junction a command put there. */
  async function fileIn(root: string, rel: string): Promise<string> {
    const target = resolveInside(root, rel);
    if (target === undefined) throw new Error('the path is outside the workspace folder');
    if (await exists(root)) {
      await resolveInWorkspaceReal(root, rel, (absPath) => fs.realpath(absPath)).catch(() => {
        throw new Error('the path leads outside the workspace folder through a symbolic link or junction');
      });
    }
    return target;
  }

  /** Writes a file; never through a link, which would change the file it points to. */
  async function writeFile(target: string, bytes: Uint8Array): Promise<void> {
    if ((await fs.lstat(target).catch(() => undefined))?.isSymbolicLink()) {
      throw new Error('it is a symbolic link now. Restore it by hand');
    }
    await files.write(target, bytes);
  }

  async function revertFile(state: ReviewState, file: ReviewFileState): Promise<void> {
    const target = await fileIn(state.root, file.path);
    if (file.status === 'added') return files.delete(target);
    const bytes = await beforeBytes(state, file.path);
    if (bytes === undefined) throw new Error('its content before the run is not available');
    await writeFile(target, bytes);
  }

  async function applyFile(state: ReviewState, file: ReviewFileState): Promise<void> {
    const target = await fileIn(state.root, file.path);
    if (file.status === 'deleted') return files.delete(target);
    const source = await fileIn(state.runRoot, file.path);
    const bytes =
      (await readIfFile(source)) ?? (await snapshots.read(runSnapshotOf(state), 'after', file.path));
    if (bytes === undefined) throw new Error("the run's version is not available");
    await writeFile(target, bytes);
  }

  /** Asks about files that changed meanwhile; resolves with the files to change, or undefined for Cancel. */
  async function confirm(
    targets: ReviewFileState[],
    changed: ReviewFileState[],
    batch: boolean,
    copy: {
      single: (file: string) => string;
      one: string;
      many: (names: string) => string;
      detail: string;
      all: string;
    },
  ): Promise<ReviewFileState[] | undefined> {
    if (changed.length === 0) return targets;
    if (!batch) {
      return (await ui.ask(copy.single(changed[0].path), undefined, [copy.one])) === copy.one
        ? targets
        : undefined;
    }
    const skip = 'Skip changed files';
    const answer = await ui.ask(copy.many(namesOf(changed)), copy.detail, [copy.all, skip]);
    if (answer === copy.all) return targets;
    if (answer === skip) return targets.filter((file) => !changed.includes(file));
    return undefined;
  }

  async function revertInWorkspace(state: ReviewState, targets: ReviewFileState[], batch: boolean) {
    const revertible: ReviewFileState[] = [];
    for (const file of targets) {
      if (file.revertible) revertible.push(file);
      else file.error = notRevertible(file.path);
    }
    const changed: ReviewFileState[] = [];
    for (const file of revertible) {
      const target = resolveInside(state.root, file.path);
      if (file.afterHash !== undefined && target && hashOf(await files.current(target)) !== file.afterHash) {
        changed.push(file);
      }
    }
    const chosen = await confirm(revertible, changed, batch, {
      single: (file) => `${file} changed after the run. Revert it anyway? Your newer changes to it are lost.`,
      one: 'Revert anyway',
      many: (names) => `${plural(changed.length, 'file')} changed after the run: ${names}.`,
      detail: 'Reverting them loses your newer changes to them.',
      all: 'Revert all anyway',
    });
    if (!chosen || chosen.length === 0) return;
    await withBusy(state, async () => {
      for (const file of chosen) {
        try {
          await revertFile(state, file);
          file.decision = 'reverted';
        } catch (error) {
          file.error = `Could not revert ${file.path}: ${errorText(error)}`;
        }
      }
    });
  }

  async function keepFromWorktree(state: ReviewState, targets: ReviewFileState[], batch: boolean) {
    if (!state.worktreeAvailable) {
      for (const file of targets)
        file.error = "The worktree of this run was removed, so this change can't be applied anymore.";
      return;
    }
    const applicable: ReviewFileState[] = [];
    for (const file of targets) {
      if (file.special)
        file.error = `${file.path} is a symbolic link or submodule. Apply this change by hand.`;
      else applicable.push(file);
    }
    const changed: ReviewFileState[] = [];
    for (const file of applicable) {
      const target = resolveInside(state.root, file.path);
      const before = await snapshots.read(workspaceSnapshotOf(state), 'before', file.path);
      if (target && !sameContent(await files.current(target), before)) changed.push(file);
    }
    const chosen = await confirm(applicable, changed, batch, {
      single: (file) =>
        `${file} changed in your workspace during the run. Replace it with the run's version?`,
      one: 'Replace',
      many: (names) =>
        `${plural(changed.length, 'file')} changed in your workspace during the run: ${names}.`,
      detail: 'Replacing them loses the changes you made in your workspace.',
      all: 'Replace all',
    });
    if (!chosen || chosen.length === 0) return;
    await withBusy(state, async () => {
      for (const file of chosen) {
        try {
          await applyFile(state, file);
          file.decision = 'kept';
        } catch (error) {
          file.error = `Could not apply ${file.path}: ${errorText(error)}`;
        }
      }
    });
  }

  async function removeWorktreeOf(state: ReviewState): Promise<void> {
    if (!state.worktreePath || !state.worktreeAvailable) return;
    try {
      await snapshots.removeWorktree(state.root, state.worktreePath);
    } catch (error) {
      log.warn(`Could not remove the worktree ${state.worktreePath}: ${errorText(error)}`);
    }
    state.worktreeAvailable = false;
  }

  const fileUri = (file: string | undefined) => (file === undefined ? undefined : vscode.Uri.file(file));

  /** The right side of a diff: the file as it is now (workspace or worktree); undefined when it is gone. */
  function currentUri(state: ReviewState, file: ReviewFileState): vscode.Uri | undefined {
    if (file.status === 'deleted') return undefined;
    if (state.isolation === 'workspace') return fileUri(resolveInside(state.root, file.path));
    return state.worktreeAvailable ? fileUri(resolveInside(state.runRoot, file.path)) : undefined;
  }

  return {
    onDidChange: onDidChange.event,

    async get(runId) {
      const state = await ready(runId);
      if (!state || state.files.length === 0) return undefined;
      return toRunReview(state, busy.has(runId));
    },

    async decide(runId, decision, paths) {
      if (!isRunId(runId) || (decision !== 'kept' && decision !== 'reverted')) return;
      if (!(await ready(runId))) return;
      await serialize(runId, async () => {
        const state = states.get(runId);
        if (!state) return;
        const wanted = paths ? new Set(paths) : undefined;
        const targets = state.files.filter(
          (f) => f.decision === 'pending' && (!wanted || wanted.has(f.path)),
        );
        if (targets.length === 0) return;
        for (const file of targets) delete file.error;
        const batch = paths === undefined || paths.length > 1;
        if (state.isolation === 'worktree') {
          if (decision === 'kept') await keepFromWorktree(state, targets, batch);
          else for (const file of targets) file.decision = 'reverted';
          if (!state.files.some((file) => file.decision === 'pending')) await removeWorktreeOf(state);
        } else if (decision === 'kept') {
          for (const file of targets) file.decision = 'kept';
        } else {
          await revertInWorkspace(state, targets, batch);
        }
        await save(state);
        await publishCounts(state);
      });
    },

    async openDiff(runId, file) {
      if (!isRelativePath(file)) return;
      const state = await ready(runId);
      const entry = state?.files.find((f) => f.path === file);
      if (!state || !entry) return;
      const current = currentUri(state, entry);
      if (entry.binary) {
        const choice = await ui.showInfo(
          "Binary files can't be compared.",
          ...(current ? ['Open file'] : []),
        );
        if (choice === 'Open file' && current) await ui.executeCommand('vscode.open', current);
        return;
      }
      const left = snapshotUri(runId, entry.status === 'added' ? 'empty' : 'before', file);
      const right = current ?? snapshotUri(runId, 'after', file);
      await ui.executeCommand(
        'vscode.diff',
        left,
        right,
        `${path.posix.basename(file)}: before the run and now`,
      );
    },

    contentProvider: {
      async provideTextDocumentContent(uri) {
        const parsed = parseSnapshotUri(uri);
        if (!parsed || parsed.side === 'empty') return '';
        const state = await ready(parsed.runId);
        if (!state) return '';
        const bytes =
          parsed.side === 'before'
            ? await beforeBytes(state, parsed.path)
            : await snapshots.read(runSnapshotOf(state), 'after', parsed.path);
        return bytes ? decoder.decode(bytes) : '';
      },
    },

    async track(state) {
      live.add(state.runId);
      states.set(state.runId, state);
      await save(state);
      return journalOf(state);
    },

    async complete(runId, completeOptions = {}) {
      const state = states.get(runId);
      live.delete(runId);
      if (!state) return 0;
      if (completeOptions.overlapping) state.overlapping = true;
      return serialize(runId, async () => {
        if (completeOptions.skipSnapshot) {
          await save(state);
          return 0;
        }
        try {
          await finalize(state);
        } catch (error) {
          log.error(`Could not build the review of run ${runId}: ${errorText(error)}`);
        }
        return states.get(runId)?.files.length ?? 0;
      });
    },

    async publish(runId) {
      const state = states.get(runId);
      if (state?.finished) await publishCounts(state);
    },

    async discard(runId) {
      live.delete(runId);
      const state = await load(runId);
      if (state) await serialize(runId, () => drop(state));
    },

    async prune(runIds) {
      for (const runId of runIds.filter(isRunId)) {
        const state = await load(runId);
        if (!state) {
          await fs.rm(reviewDir(storageDir, runId), { recursive: true, force: true, maxRetries: 3 });
          continue;
        }
        await serialize(runId, () => drop(state));
        fire(state);
      }
    },

    async removeWorktree(runId) {
      const state = await load(runId);
      if (!state?.worktreeAvailable) return;
      await serialize(runId, async () => {
        await removeWorktreeOf(state);
        await save(state);
      });
      fire(state);
    },

    isLive: (runId) => live.has(runId),
    state: (runId) => (isRunId(runId) ? load(runId) : Promise.resolve(undefined)),

    async storedRunIds() {
      try {
        return (await fs.readdir(path.join(storageDir, 'reviews'))).filter(isRunId);
      } catch {
        return [];
      }
    },

    dispose() {
      disposed = true;
      onDidChange.dispose();
    },
  };
}
