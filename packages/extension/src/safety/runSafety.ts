import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowIsolation } from '@isar-flow/core';
import type { RunHistory } from '../contracts';
import type { RunEditJournal } from './editJournal';
import { createGitSnapshots, worktreeNeedsGit, type GitSnapshots, type SafetySnapshot } from './gitSnapshots';
import {
  createReviewService,
  type ReviewUi,
  type RunReviewService,
  type WorkspaceFiles,
} from './reviewService';
import type { ReviewState } from './reviewState';
import { isRunId } from './snapshotUri';
import { errorText, type SafetyLog } from './util';
import { createVscodeWorkspaceFiles, vscodeReviewUi } from './workspaceFiles';

export interface RunSafetyOptions {
  /** Extension storage: reviews, journals, temporary index files and worktrees live below it. */
  storageDir: string;
  log: SafetyLog;
  history: RunHistory;
  snapshots?: GitSnapshots;
  files?: WorkspaceFiles;
  ui?: ReviewUi;
}

export interface BeginOptions {
  runId: string;
  workflowUri: string;
  /** Folder the run changes: the workflow's workspace folder. */
  folder: string;
  isolation: WorkflowIsolation;
}

/** Safety net of one run: snapshot before, edit journal during, review after. */
export interface SafetySession {
  readonly runId: string;
  /** Folder the run works in: the workspace folder, or the matching folder of the run's worktree. */
  readonly root: string;
  readonly journal: RunEditJournal;
  /** After snapshot and review; resolves with the number of changed files. skipSnapshot: VS Code is closing. */
  finish(options?: { skipSnapshot?: boolean }): Promise<number>;
  /** Stores the review counts in the history (call after the run was saved there) and tells listeners. */
  publish(): Promise<void>;
  /** Drops the snapshots, journal and worktree, e.g. when the setup commands failed. */
  discard(): Promise<void>;
}

export interface RunSafety {
  readonly reviews: RunReviewService;
  /** Whether `folder` is in a git repository, which isolation: worktree needs. */
  canIsolate(folder: string): Promise<boolean>;
  /** Snapshots the folder (and creates the worktree); rejects with a user-facing message for worktree runs. */
  begin(options: BeginOptions): Promise<SafetySession>;
  /** Removes worktrees and reviews that no saved run needs any more, then runs git worktree prune. */
  cleanup(): Promise<void>;
  /** Resolves once background work (pruning) has finished. */
  whenIdle(): Promise<void>;
  dispose(): void;
}

const folderKey = (folder: string) => {
  const resolved = path.resolve(folder);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** The main repository of a worktree folder, from its `.git` file (gitdir: <repo>/.git/worktrees/<name>). */
async function repositoryOfWorktree(worktree: string): Promise<string | undefined> {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(path.join(worktree, '.git'), 'utf8'));
    if (!match) return undefined;
    const commonDir = path.resolve(worktree, match[1].trim(), '..', '..');
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : undefined;
  } catch {
    return undefined;
  }
}

export function createRunSafety(options: RunSafetyOptions): RunSafety {
  const { storageDir, log, history } = options;
  const snapshots = options.snapshots ?? createGitSnapshots({ storageDir, log });
  const reviews = createReviewService({
    storageDir,
    snapshots,
    history,
    files: options.files ?? createVscodeWorkspaceFiles(),
    ui: options.ui ?? vscodeReviewUi,
    log,
  });
  /** Live workspace runs per folder, to flag runs that changed the same folder at the same time. */
  const active = new Map<string, Set<string>>();
  const overlapping = new Set<string>();
  /**
   * Runs begun in this session. Cleanup leaves them alone until they are in the history (also while their worktree
   * is being created, and after the run ended but before its history entry was saved): their end, discard and the
   * history pruning remove what they leave.
   */
  const begun = new Set<string>();
  const ownedUnsaved = (runId: string, saved: Set<string>) =>
    reviews.isLive(runId) || (begun.has(runId) && !saved.has(runId));
  const background = new Set<Promise<unknown>>();
  const inBackground = (task: Promise<unknown>) => {
    const tracked = task.catch((error: unknown) => log.warn(`Run safety: ${errorText(error)}`));
    background.add(tracked);
    void tracked.finally(() => background.delete(tracked));
  };
  const removal = history.onDidRemove?.(({ runIds }) => inBackground(reviews.prune(runIds)));

  async function createWorktree(runId: string, folder: string, snapshot: SafetySnapshot) {
    if (snapshot.coverage !== 'git') {
      const repository = await snapshots.repository(folder);
      throw new Error(
        repository
          ? `Could not take the snapshot of ${folder} that the worktree starts from. See the Isar Flow log for details.`
          : worktreeNeedsGit(folder),
      );
    }
    const worktreePath = path.join(storageDir, 'worktrees', runId);
    try {
      await snapshots.createWorktree(snapshot, worktreePath);
    } catch (error) {
      await snapshots.removeWorktree(folder, worktreePath).catch(() => undefined);
      await snapshots.prune(folder, [runId]);
      throw error;
    }
    const runRoot = path.join(worktreePath, ...(snapshot.prefix ?? '').split('/').filter(Boolean));
    return { worktreePath, runRoot };
  }

  return {
    reviews,

    async canIsolate(folder) {
      return (await snapshots.repository(folder)) !== undefined;
    },

    async begin({ runId, workflowUri, folder, isolation }) {
      begun.add(runId);
      // Registered before the snapshot: another run that changes the folder meanwhile overlaps with this one.
      const key = folderKey(folder);
      if (isolation === 'workspace') {
        const others = active.get(key) ?? new Set<string>();
        if (others.size > 0) for (const id of [...others, runId]) overlapping.add(id);
        active.set(key, others.add(runId));
      }
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        active.get(key)?.delete(runId);
      };

      const snapshot = await snapshots.begin(runId, folder);
      const worktree = isolation === 'worktree' ? await createWorktree(runId, folder, snapshot) : undefined;
      const state: ReviewState = {
        version: 1,
        runId,
        workflowUri,
        root: folder,
        runRoot: worktree?.runRoot ?? folder,
        isolation,
        coverage: snapshot.coverage,
        ...(snapshot.repoTop !== undefined && { repoTop: snapshot.repoTop }),
        ...(snapshot.prefix !== undefined && { prefix: snapshot.prefix }),
        ...(snapshot.before !== undefined && { before: snapshot.before }),
        ...(worktree && { worktreePath: worktree.worktreePath, worktreeAvailable: true }),
        finished: false,
        files: [],
      };
      const journal = await reviews.track(state);

      return {
        runId,
        root: state.runRoot,
        journal,
        async finish(finishOptions = {}) {
          end();
          const count = await reviews.complete(runId, {
            ...finishOptions,
            overlapping: overlapping.has(runId),
          });
          overlapping.delete(runId);
          return count;
        },
        publish: () => reviews.publish(runId),
        async discard() {
          end();
          overlapping.delete(runId);
          await reviews.discard(runId);
        },
      };
    },

    async cleanup() {
      const saved = new Set(history.list().map((record) => record.runId));
      const repositories = new Set<string>();
      for (const runId of await reviews.storedRunIds()) {
        if (saved.has(runId) || ownedUnsaved(runId, saved)) continue;
        const state = await reviews.state(runId);
        if (state) repositories.add(state.root);
        await reviews.prune([runId]);
      }

      const worktrees = path.join(storageDir, 'worktrees');
      const names = await fs.readdir(worktrees).catch(() => [] as string[]);
      for (const runId of names) {
        if (ownedUnsaved(runId, saved)) continue;
        const state = isRunId(runId) ? await reviews.state(runId) : undefined;
        const needed =
          state?.worktreeAvailable &&
          saved.has(runId) &&
          (!state.finished || state.files.some((file) => file.decision === 'pending'));
        if (needed) continue;
        if (state?.worktreeAvailable) {
          repositories.add(state.root);
          await reviews.removeWorktree(runId);
          continue;
        }
        const folder = path.join(worktrees, runId);
        const repository = await repositoryOfWorktree(folder);
        if (repository) {
          repositories.add(repository);
          await snapshots.removeWorktree(repository, folder);
        } else {
          await fs.rm(folder, { recursive: true, force: true, maxRetries: 3 });
        }
      }
      for (const repository of repositories) await snapshots.pruneWorktrees(repository);
    },

    async whenIdle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },

    dispose() {
      removal?.dispose();
      reviews.dispose();
    },
  };
}
