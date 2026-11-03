import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EditJournal, EditJournalEntry } from '../contracts';
import { errorText, hashFile, readIfFile, relativeTo, resolveInside, type SafetyLog } from './util';

const JOURNAL_FILE = 'journal.json';
const DEFAULT_LIMITS = { fileBytes: 2 * 1024 * 1024, runBytes: 50 * 1024 * 1024 };

export interface EditJournalOptions {
  runId: string;
  /** Folder the run works in; journal paths are relative to it. */
  root: string;
  /** Folder of this run's journal, `<storage>/reviews/<runId>`. */
  dir: string;
  log: SafetyLog;
  /** Keeps an original that is over the size caps (git hash-object -w); undefined when that is not possible. */
  storeLarge?: (absPath: string) => Promise<string | undefined>;
  readLarge?: (id: string) => Promise<Uint8Array | undefined>;
  limits?: { fileBytes: number; runBytes: number };
  now?: () => number;
}

/** The journal of one run, with what the review needs beyond the contract. */
export interface RunEditJournal extends EditJournal {
  /** Resolves once a journal saved earlier (before a restart) has been read. */
  readonly ready: Promise<void>;
  /** Records a hash of every journaled file as it is now, at the end of the run. */
  seal(): Promise<void>;
  /** Hash recorded by seal(); 'missing' for a file that did not exist then. */
  sealedHash(path: string): string | undefined;
  isSymlink(path: string): boolean;
  /** The original is the unsaved text of an editor (the file on disk did not have it), so git can't replace it. */
  hadUnsavedChanges(path: string): boolean;
}

interface StoredEntry extends EditJournalEntry {
  /** Original bytes, relative to the journal folder. */
  file?: string;
  /** Original stored as a git blob. */
  blob?: string;
  symlink?: boolean;
  sealedHash?: string;
  unsaved?: boolean;
}

/** Real path of `absPath`, or of its nearest existing ancestor with the missing parts appended. */
async function realPathOfNearest(absPath: string): Promise<string | undefined> {
  const missing: string[] = [];
  for (let current = absPath; ;) {
    try {
      return path.join(await fs.realpath(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** The bytes of an editor's unsaved text, with the UTF-8 byte order mark of the file on disk, if it has one. */
async function unsavedBytes(text: string, absPath: string): Promise<Buffer> {
  const bytes = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(UTF8_BOM.length);
  try {
    const handle = await fs.open(absPath, 'r');
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
  } catch {
    return bytes;
  }
  return head.equals(UTF8_BOM) ? Buffer.concat([UTF8_BOM, bytes]) : bytes;
}

function isStoredEntry(value: unknown): value is StoredEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    Array.isArray(entry.stepIds) &&
    entry.stepIds.every((id) => typeof id === 'string') &&
    typeof entry.existed === 'boolean' &&
    typeof entry.originalStored === 'boolean' &&
    typeof entry.at === 'number'
  );
}

/**
 * Opens the edit journal of a run (reading one saved before a restart). The first write per file keeps the
 * file's original bytes (≤ 2 MB per file, ≤ 50 MB per run; larger ones as git blobs when possible). Never
 * rejects: storage problems are logged and the file is marked as not revertible.
 */
export function openEditJournal(options: EditJournalOptions): RunEditJournal {
  const { runId, root, dir, log } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, StoredEntry>();
  const inflight = new Map<string, Promise<void>>();
  let storedBytes = 0;
  let saving: Promise<void> = Promise.resolve();
  let realRoot: Promise<string | undefined> | undefined;
  let lookups: Promise<void> = Promise.resolve();

  /**
   * `absPath` relative to the root as the file system spells it (letter case, short names like GIT~1, linked
   * folders), so it matches the path git reports; a link keeps its own name. Else the path as given.
   */
  async function journalPath(absPath: string): Promise<string | undefined> {
    const given = relativeTo(root, absPath);
    if (given === undefined) return undefined;
    const isLink = await fs.lstat(absPath).then(
      (stat) => stat.isSymbolicLink(),
      () => false,
    );
    const real = isLink
      ? await realPathOfNearest(path.dirname(absPath)).then(
          (folder) => folder && path.join(folder, path.basename(absPath)),
        )
      : await realPathOfNearest(absPath);
    const top = await (realRoot ??= fs.realpath(root).catch(() => undefined));
    return (top !== undefined && real !== undefined && relativeTo(top, real)) || given;
  }

  const ready = (async () => {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, JOURNAL_FILE), 'utf8')) as {
        entries?: unknown;
        storedBytes?: unknown;
      };
      if (typeof data.storedBytes === 'number') storedBytes = data.storedBytes;
      for (const entry of Array.isArray(data.entries) ? data.entries : []) {
        if (isStoredEntry(entry)) entries.set(entry.path, entry);
      }
    } catch {
      // A new journal.
    }
  })();

  const save = () => {
    const json = JSON.stringify({ version: 1, runId, root, storedBytes, entries: [...entries.values()] });
    saving = saving
      .then(async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, JOURNAL_FILE), json);
      })
      .catch((error: unknown) =>
        log.warn(`Could not save the edit journal of run ${runId}: ${errorText(error)}`),
      );
    return saving;
  };

  /** Keeps the file's bytes, or `unsaved` (an editor's text, which git can't store from the file). */
  async function keepOriginal(
    rel: string,
    absPath: string,
    size: number,
    unsaved?: Uint8Array,
  ): Promise<Partial<StoredEntry>> {
    if (size <= limits.fileBytes && storedBytes + size <= limits.runBytes) {
      storedBytes += size;
      try {
        const file = `originals/${randomUUID()}.bin`;
        const bytes = unsaved ?? (await fs.readFile(absPath));
        await fs.mkdir(path.join(dir, 'originals'), { recursive: true });
        await fs.writeFile(path.join(dir, file), bytes);
        return { originalStored: true, file };
      } catch (error) {
        storedBytes -= size;
        log.warn(`Could not keep the original of ${rel} for run ${runId}: ${errorText(error)}`);
      }
    }
    const blob = unsaved ? undefined : await options.storeLarge?.(absPath);
    if (blob) return { originalStored: true, blob };
    log.info(
      `The original of ${rel} was not kept (too large or not stored), so run ${runId} can't revert it.`,
    );
    return { originalStored: false };
  }

  async function record(rel: string, absPath: string, stepId: string, unsaved?: string): Promise<void> {
    const base = { path: rel, stepIds: [stepId], at: now() };
    let stat;
    try {
      stat = await fs.lstat(absPath);
    } catch (error) {
      // Only a file that is really missing may be deleted by a revert.
      const missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
      if (!missing) log.warn(`Could not check ${rel} for run ${runId}: ${errorText(error)}`);
      entries.set(rel, { ...base, existed: !missing, originalStored: missing });
      return;
    }
    if (!stat.isFile()) {
      entries.set(rel, { ...base, existed: true, originalStored: false, symlink: stat.isSymbolicLink() });
      return;
    }
    const bytes = unsaved === undefined ? undefined : await unsavedBytes(unsaved, absPath);
    entries.set(rel, {
      ...base,
      existed: true,
      originalStored: false,
      ...(bytes && { unsaved: true }),
      ...(await keepOriginal(rel, absPath, bytes?.length ?? stat.size, bytes)),
    });
  }

  return {
    runId,
    ready,

    async beforeWrite(absPath, stepId, unsaved) {
      try {
        await ready;
        // Paths are looked up one after the other, so concurrent writes are recorded in the order of the calls.
        const lookup = lookups.then(() => journalPath(absPath));
        lookups = lookup.then(
          () => undefined,
          () => undefined,
        );
        const rel = await lookup;
        if (rel === undefined) return;
        const pending = inflight.get(rel);
        if (pending) await pending;
        const entry = entries.get(rel);
        if (entry) {
          if (entry.stepIds.includes(stepId)) return;
          entry.stepIds.push(stepId);
        } else {
          const recording = record(rel, absPath, stepId, unsaved);
          inflight.set(rel, recording);
          try {
            await recording;
          } finally {
            inflight.delete(rel);
          }
        }
        await save();
      } catch (error) {
        log.warn(`The edit journal of run ${runId} could not record ${absPath}: ${errorText(error)}`);
      }
    },

    entries: () =>
      [...entries.values()].map(({ path: file, stepIds, existed, originalStored, at }) => ({
        path: file,
        stepIds: [...stepIds],
        existed,
        originalStored,
        at,
      })),

    async original(rel) {
      await ready;
      const entry = entries.get(rel);
      if (!entry) return undefined;
      if (!entry.existed) return null;
      if (entry.file) return readIfFile(path.join(dir, entry.file));
      if (entry.blob) return options.readLarge?.(entry.blob);
      return undefined;
    },

    async seal() {
      await ready;
      await Promise.all(inflight.values());
      for (const entry of entries.values()) {
        const file = resolveInside(root, entry.path);
        entry.sealedHash = await hashFile(file);
      }
      if (entries.size > 0) await save();
    },

    sealedHash: (rel) => entries.get(rel)?.sealedHash,
    isSymlink: (rel) => entries.get(rel)?.symlink === true,
    hadUnsavedChanges: (rel) => entries.get(rel)?.unsaved === true,
  };
}
