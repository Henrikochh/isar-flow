import type { EditJournalEntry } from '../contracts';
import type { RunEditJournal } from './editJournal';
import type { GitChange } from './gitSnapshots';
import { lineStats } from './lineStats';
import type { ReviewFileState, ReviewState } from './reviewState';
import { hashFile, readIfFile, resolveInside, sameBytes } from './util';

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A file only the journal knows about (no git, or ignored by git): compared with its original. */
async function journalChange(
  state: ReviewState,
  journal: RunEditJournal,
  entry: EditJournalEntry,
): Promise<ReviewFileState | undefined> {
  const file = resolveInside(state.runRoot, entry.path);
  if (file === undefined) return undefined;
  const base = { path: entry.path, stepIds: entry.stepIds, decision: 'pending' as const };
  // Worktree runs only drop changes, which is always possible.
  const anyRevertible = state.isolation === 'worktree';
  if (journal.isSymlink(entry.path)) return { ...base, status: 'modified', revertible: anyRevertible };

  const current = await readIfFile(file);
  const original = await journal.original(entry.path);
  if (original === null) {
    if (current === undefined) return undefined;
    return { ...base, status: 'added', ...lineStats(null, current), revertible: true };
  }
  if (original === undefined) {
    return { ...base, status: current === undefined ? 'deleted' : 'modified', revertible: anyRevertible };
  }
  if (current === undefined)
    return { ...base, status: 'deleted', ...lineStats(original, null), revertible: true };
  if (sameBytes(original, current)) return undefined;
  return { ...base, status: 'modified', ...lineStats(original, current), revertible: true };
}

/**
 * The changed files of a finished run: the git changes plus the files agents wrote that git does not cover,
 * with the blocks that wrote them, sorted by path. Workspace runs also get the hash of each file right after
 * the run, so later edits can be detected before a revert overwrites them.
 */
export async function buildReviewFiles(
  state: ReviewState,
  changes: GitChange[],
  journal: RunEditJournal,
): Promise<ReviewFileState[]> {
  const entries = new Map(journal.entries().map((entry) => [entry.path, entry]));
  const files = new Map<string, ReviewFileState>();
  for (const change of changes) {
    const special = change.special ?? (journal.isSymlink(change.path) ? 'symlink' : undefined);
    const entry = entries.get(change.path);
    // The snapshot lacks the unsaved editor text that the write saved, so only the journal can restore it.
    const unsavedLost = journal.hadUnsavedChanges(change.path) && entry?.originalStored !== true;
    files.set(change.path, {
      path: change.path,
      status: change.status,
      ...(change.binary ? { binary: true } : { additions: change.additions, deletions: change.deletions }),
      stepIds: entry?.stepIds ?? [],
      decision: 'pending',
      revertible: state.isolation === 'worktree' || (special === undefined && !unsavedLost),
      ...(special && { special }),
    });
  }
  for (const entry of entries.values()) {
    if (files.has(entry.path)) continue;
    const file = await journalChange(state, journal, entry);
    if (file) files.set(entry.path, file);
  }
  if (state.isolation === 'workspace') {
    for (const file of files.values()) {
      file.afterHash =
        journal.sealedHash(file.path) ?? (await hashFile(resolveInside(state.root, file.path)));
    }
  }
  return [...files.values()].sort(byPath);
}
