import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunSnapshot, SnapshotChange, SnapshotService } from '../contracts';
import { createGitRunner, GitError, splitNul, type GitRunner } from './git';
import { errorText, exists, type SafetyLog } from './util';

const SNAPSHOT_TIMEOUT_MS = 60_000;
/** rev-parse, diff and read calls. */
const QUICK_TIMEOUT_MS = 30_000;
/** Checking out a large repository takes a while. */
const WORKTREE_TIMEOUT_MS = 10 * 60_000;
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Isar Flow',
  GIT_AUTHOR_EMAIL: 'isarflow@localhost',
  GIT_COMMITTER_NAME: 'Isar Flow',
  GIT_COMMITTER_EMAIL: 'isarflow@localhost',
};

export interface RepoInfo {
  /** Top folder of the repository (or of the worktree). */
  top: string;
  /** Folder of the snapshot root inside the repository: '' or ending with '/'. */
  prefix: string;
}

export interface SafetySnapshot extends RunSnapshot {
  repoTop?: string;
  prefix?: string;
}

export interface GitChange extends SnapshotChange {
  /** Symbolic links and submodule pointers can't be restored from file contents. */
  special?: 'symlink' | 'submodule';
}

export interface GitSnapshots extends SnapshotService {
  begin(runId: string, root: string): Promise<SafetySnapshot>;
  finish(snapshot: SafetySnapshot): Promise<{ snapshot: SafetySnapshot; changes: GitChange[] }>;
  /** Top and prefix of the repository that contains `root`; undefined without git or outside a repository. */
  repository(root: string): Promise<RepoInfo | undefined>;
  /** Stores a file's bytes unfiltered in the object database; undefined when that fails. */
  storeBlob(root: string, absPath: string): Promise<string | undefined>;
  readBlob(root: string, id: string): Promise<Uint8Array | undefined>;
  /** `git worktree prune` (forgets worktrees whose folder is gone). */
  pruneWorktrees(root: string): Promise<void>;
}

export interface GitSnapshotsOptions {
  /** Extension storage; temporary index files live in `snapshots/` below it. */
  storageDir: string;
  log: SafetyLog;
  timeoutMs?: number;
  gitPath?: string;
  git?: GitRunner;
}

export const snapshotRef = (runId: string, side: 'before' | 'after') => `refs/isarflow/runs/${runId}/${side}`;

export function worktreeNeedsGit(folder: string): string {
  return `Isolation "worktree" needs a git repository. Run git init in ${folder}, or set isolation to workspace.`;
}

const safeName = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * Snapshots with a temporary index (GIT_INDEX_FILE): a copy of the user's index, so only changed files are
 * hashed again, then add -A, write-tree and commit-tree. The user's index, HEAD, branch, stash and working tree
 * are never touched; the commits are kept alive by refs under refs/isarflow/runs/<runId>/.
 */
export function createGitSnapshots(options: GitSnapshotsOptions): GitSnapshots {
  const git = options.git ?? createGitRunner(options.gitPath);
  const { log, storageDir } = options;
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  const logged = new Set<string>();
  const logOnce = (key: string, message: string) => {
    if (logged.has(key)) return;
    logged.add(key);
    log.info(message);
  };

  const text = async (args: string[], cwd: string, timeout = QUICK_TIMEOUT_MS) =>
    (await git(args, { cwd, timeoutMs: timeout })).toString('utf8');

  async function repository(root: string): Promise<RepoInfo | undefined> {
    if (!(await exists(root))) return undefined;
    try {
      const [top, prefix = ''] = (await text(['rev-parse', '--show-toplevel', '--show-prefix'], root))
        .replace(/\r/g, '')
        .split('\n');
      return { top: path.resolve(top), prefix };
    } catch (error) {
      if (error instanceof GitError && error.missing) {
        logOnce(
          'git',
          `${error.message} Runs are not snapshotted, so only files that agents write can be reviewed.`,
        );
      } else if (error instanceof GitError && error.timedOut) {
        log.warn(`Could not check whether ${root} is a git repository: ${error.message}`);
      } else {
        logOnce(root, `${root} is not a git repository, so only files that agents write can be reviewed.`);
      }
      return undefined;
    }
  }

  async function commitSnapshot(runId: string, root: string, side: 'before' | 'after'): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const call = async (args: string[], env?: Record<string, string>) =>
      (await git(args, { cwd: root, env, timeoutMs: Math.max(1, deadline - Date.now()) }))
        .toString('utf8')
        .trim();
    const folder = path.join(storageDir, 'snapshots');
    await fs.mkdir(folder, { recursive: true });
    const index = path.join(folder, `${safeName(runId)}-${side}-${randomUUID().slice(0, 8)}.index`);
    try {
      const userIndex = path.resolve(root, await call(['rev-parse', '--git-path', 'index']));
      try {
        await fs.copyFile(userIndex, index);
      } catch (error) {
        // No index yet (repository without commits) or unreadable: start from an empty index.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          log.warn(`Could not copy ${userIndex}: ${errorText(error)}`);
      }
      const env = { GIT_INDEX_FILE: index };
      // core.safecrlf only warns about line ending conversion, but set to true it makes add fail.
      await call(['-c', 'core.safecrlf=false', 'add', '-A', '--', '.'], env);
      const tree = await call(['write-tree'], env);
      const message = `Isar Flow run ${runId} (${side})`;
      const commit = await call(['commit-tree', '--no-gpg-sign', '-m', message, tree], IDENTITY);
      await call(['update-ref', snapshotRef(runId, side), commit]);
      return commit;
    } finally {
      await Promise.all([fs.rm(index, { force: true }), fs.rm(`${index}.lock`, { force: true })]);
    }
  }

  async function diff(snapshot: SafetySnapshot, before: string, after: string): Promise<GitChange[]> {
    const prefix = snapshot.prefix ?? '';
    const spec = prefix ? ['--', `:(top,literal)${prefix.replace(/\/$/, '')}`] : [];
    const common = ['diff-tree', '-r', '-z', '--no-renames'];
    const call = (args: string[]) => git(args, { cwd: snapshot.root, timeoutMs: QUICK_TIMEOUT_MS });
    const [raw, numstat] = await Promise.all([
      call([...common, '--raw', before, after, ...spec]),
      call([...common, '--numstat', before, after, ...spec]),
    ]);
    const relative = (file: string) => (file.startsWith(prefix) ? file.slice(prefix.length) : file);

    const counts = new Map<string, { additions: number; deletions: number } | 'binary'>();
    for (const record of splitNul(numstat)) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(record);
      if (!match) continue;
      const [, added, deleted, file] = match;
      counts.set(file, added === '-' ? 'binary' : { additions: Number(added), deletions: Number(deleted) });
    }

    const changes: GitChange[] = [];
    const parts = splitNul(raw);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const [srcMode, dstMode, , , letter] = parts[i].replace(/^:/, '').split(' ');
      const file = parts[i + 1];
      const status = letter.startsWith('A') ? 'added' : letter.startsWith('D') ? 'deleted' : 'modified';
      const modes = [srcMode, dstMode];
      const special = modes.includes('160000')
        ? 'submodule'
        : modes.includes('120000')
          ? 'symlink'
          : undefined;
      const count = counts.get(file);
      changes.push({
        path: relative(file),
        status,
        ...(count === 'binary' ? { binary: true } : count),
        ...(special && { special }),
      });
    }
    return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Commands that read from the object database run in the root, or the repository when the root is gone. */
  const cwdOf = async (snapshot: SafetySnapshot) =>
    (await exists(snapshot.root)) || !snapshot.repoTop ? snapshot.root : snapshot.repoTop;

  return {
    repository,

    async begin(runId, root) {
      const repo = await repository(root);
      if (!repo) return { runId, root, coverage: 'journal' };
      try {
        const before = await commitSnapshot(runId, root, 'before');
        return { runId, root, coverage: 'git', before, repoTop: repo.top, prefix: repo.prefix };
      } catch (error) {
        log.warn(
          `Could not snapshot ${root} before run ${runId}: ${errorText(error)} Only files that agents write can be reviewed for this run.`,
        );
        return { runId, root, coverage: 'journal' };
      }
    },

    async finish(snapshot) {
      if (snapshot.coverage !== 'git' || !snapshot.before) return { snapshot, changes: [] };
      try {
        const known =
          snapshot.prefix !== undefined ? snapshot : { ...snapshot, ...(await repository(snapshot.root)) };
        const after = await commitSnapshot(snapshot.runId, snapshot.root, 'after');
        const next: SafetySnapshot = { ...snapshot, after, prefix: known.prefix ?? '' };
        return { snapshot: next, changes: await diff(next, snapshot.before, after) };
      } catch (error) {
        log.warn(
          `Could not snapshot ${snapshot.root} after run ${snapshot.runId}: ${errorText(error)} Only files that agents wrote can be reviewed for this run.`,
        );
        return { snapshot: { ...snapshot, coverage: 'journal' }, changes: [] };
      }
    },

    async read(snapshot: SafetySnapshot, side, file) {
      const commit = side === 'before' ? snapshot.before : snapshot.after;
      if (!commit) return undefined;
      const cwd = await cwdOf(snapshot);
      const prefix = snapshot.prefix ?? (await repository(cwd))?.prefix ?? '';
      const spec = `${commit}:${prefix}${file}`;
      const read = async (args: string[]) =>
        new Uint8Array(await git(args, { cwd, timeoutMs: QUICK_TIMEOUT_MS }));
      try {
        return await read(['cat-file', '--filters', spec]);
      } catch {
        // Not in the tree, or a filter failed: then the stored bytes as they are.
        try {
          await read(['cat-file', '-e', spec]);
          return await read(['cat-file', 'blob', spec]);
        } catch {
          return undefined;
        }
      }
    },

    async createWorktree(snapshot, worktreePath) {
      if (snapshot.coverage !== 'git' || !snapshot.before) throw new Error(worktreeNeedsGit(snapshot.root));
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      try {
        await git(['worktree', 'add', '--detach', worktreePath, snapshot.before], {
          cwd: snapshot.root,
          timeoutMs: WORKTREE_TIMEOUT_MS,
        });
      } catch (error) {
        throw new Error(`Could not create a git worktree for this run: ${errorText(error)}`, {
          cause: error,
        });
      }
    },

    async removeWorktree(repoRoot, worktreePath) {
      const repoExists = await exists(repoRoot);
      if (repoExists) {
        await git(['worktree', 'remove', '--force', worktreePath], {
          cwd: repoRoot,
          timeoutMs: QUICK_TIMEOUT_MS,
        }).catch(() => undefined);
      }
      if (await exists(worktreePath)) {
        await fs.rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      }
      if (repoExists) await this.pruneWorktrees(repoRoot);
    },

    async pruneWorktrees(root) {
      await git(['worktree', 'prune'], { cwd: root, timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
    },

    async prune(root, runIds) {
      if (runIds.length === 0 || !(await exists(root))) return;
      try {
        const listed = await text(['for-each-ref', '--format=%(refname)', 'refs/isarflow/runs/'], root);
        const wanted = new Set(runIds);
        const doomed = listed.split(/\r?\n/).filter((ref) => ref && wanted.has(ref.split('/')[3]));
        if (doomed.length === 0) return;
        const input = new TextEncoder().encode(doomed.map((ref) => `delete ${ref}\n`).join(''));
        await git(['update-ref', '--stdin'], { cwd: root, input, timeoutMs: QUICK_TIMEOUT_MS });
      } catch (error) {
        if (!(error instanceof GitError && error.missing)) {
          log.warn(`Could not remove the snapshots of old runs in ${root}: ${errorText(error)}`);
        }
      }
    },

    async storeBlob(root, absPath) {
      try {
        return (await text(['hash-object', '-w', '--no-filters', '--', absPath], root)).trim();
      } catch {
        return undefined;
      }
    },

    async readBlob(root, id) {
      try {
        return new Uint8Array(
          await git(['cat-file', 'blob', id], { cwd: root, timeoutMs: QUICK_TIMEOUT_MS }),
        );
      } catch {
        return undefined;
      }
    },
  };
}
