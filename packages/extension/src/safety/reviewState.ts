import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ReviewCounts,
  ReviewDecision,
  ReviewFile,
  ReviewFileStatus,
  RunReview,
  WorkflowIsolation,
} from '@isar-flow/core';
import type { SafetySnapshot } from './gitSnapshots';

export const MAX_LISTED_FILES = 500;
const STATE_FILE = 'review.json';

export interface ReviewFileState {
  path: string;
  status: ReviewFileStatus;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  stepIds: string[];
  decision: ReviewDecision;
  revertible: boolean;
  error?: string;
  /** Symbolic link or submodule pointer: its content can't be written back. */
  special?: 'symlink' | 'submodule';
  /** Workspace runs: sha256 of the file right after the run ('missing' when it was gone), for "changed after the run". */
  afterHash?: string;
}

/** Everything a review needs, saved as `<storage>/reviews/<runId>/review.json`. */
export interface ReviewState {
  version: 1;
  runId: string;
  workflowUri: string;
  /** Workspace folder that keep and revert change. */
  root: string;
  /** Folder the run worked in: `root`, or the matching folder of the worktree. */
  runRoot: string;
  isolation: WorkflowIsolation;
  coverage: 'git' | 'journal';
  repoTop?: string;
  prefix?: string;
  before?: string;
  after?: string;
  worktreePath?: string;
  worktreeAvailable?: boolean;
  /** False until the after snapshot was taken (it is taken on first use when VS Code closed during the run). */
  finished: boolean;
  overlapping?: boolean;
  files: ReviewFileState[];
}

export const reviewDir = (storageDir: string, runId: string) => path.join(storageDir, 'reviews', runId);

/** The snapshot of the folder the run worked in (the worktree folder for worktree runs). */
export function runSnapshotOf(state: ReviewState): SafetySnapshot {
  return {
    runId: state.runId,
    root: state.runRoot,
    coverage: state.coverage,
    ...(state.before !== undefined && { before: state.before }),
    ...(state.after !== undefined && { after: state.after }),
    ...(state.repoTop !== undefined && { repoTop: state.repoTop }),
    ...(state.prefix !== undefined && { prefix: state.prefix }),
  };
}

/** The same commits read from the workspace folder, which exists longer than a worktree. */
export const workspaceSnapshotOf = (state: ReviewState): SafetySnapshot => ({
  ...runSnapshotOf(state),
  root: state.root,
});

export function countsOf(state: ReviewState): ReviewCounts {
  const counts = { total: state.files.length, kept: 0, reverted: 0, pending: 0 };
  for (const file of state.files) counts[file.decision]++;
  return counts;
}

function toReviewFile(file: ReviewFileState): ReviewFile {
  return {
    path: file.path,
    status: file.status,
    ...(file.additions !== undefined && { additions: file.additions }),
    ...(file.deletions !== undefined && { deletions: file.deletions }),
    ...(file.binary && { binary: true }),
    stepIds: [...file.stepIds],
    decision: file.decision,
    revertible: file.revertible,
    ...(file.error !== undefined && { error: file.error }),
  };
}

export function toRunReview(state: ReviewState, busy: boolean): RunReview {
  const omitted = state.files.length - MAX_LISTED_FILES;
  const omittedPending = state.files.slice(MAX_LISTED_FILES).filter((f) => f.decision === 'pending').length;
  return {
    runId: state.runId,
    coverage: state.coverage,
    isolation: state.isolation,
    files: state.files.slice(0, MAX_LISTED_FILES).map(toReviewFile),
    ...(omitted > 0 && { omitted }),
    ...(omittedPending > 0 && { omittedPending }),
    ...(state.isolation === 'worktree' && { worktreeAvailable: state.worktreeAvailable === true }),
    ...(state.overlapping && { overlapping: true }),
    ...(busy && { busy: true }),
  };
}

function isState(value: unknown, runId: string): value is ReviewState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    state.runId === runId &&
    typeof state.workflowUri === 'string' &&
    typeof state.root === 'string' &&
    typeof state.runRoot === 'string' &&
    (state.isolation === 'workspace' || state.isolation === 'worktree') &&
    (state.coverage === 'git' || state.coverage === 'journal') &&
    typeof state.finished === 'boolean' &&
    Array.isArray(state.files)
  );
}

export async function readReviewState(storageDir: string, runId: string): Promise<ReviewState | undefined> {
  try {
    const value: unknown = JSON.parse(
      await fs.readFile(path.join(reviewDir(storageDir, runId), STATE_FILE), 'utf8'),
    );
    return isState(value, runId) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeReviewState(storageDir: string, state: ReviewState): Promise<void> {
  const dir = reviewDir(storageDir, state.runId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, STATE_FILE);
  // Write then rename, so a crash never leaves half a file.
  await fs.writeFile(`${file}.tmp`, JSON.stringify(state));
  await fs.rename(`${file}.tmp`, file);
}
