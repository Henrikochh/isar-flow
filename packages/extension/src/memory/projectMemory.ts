import * as vscode from 'vscode';
import {
  appendMemoryNote,
  checkMemoryNote,
  MEMORY_FILE,
  MEMORY_FILE_MAX_BYTES,
  memoryNoteLine,
  type ProjectMemory,
} from '@isar-flow/core';
import type { EditJournalWriter } from '../contracts';
import type { MemoryDocuments, MemoryFs } from './memoryIo';
import { utf8Bytes } from './memoryState';

export const MEMORY_TOO_LARGE = `The project memory is over 64 KB. Ask the user to tidy ${MEMORY_FILE}.`;

export interface ProjectMemoryDeps {
  /** Absolute path of the memory file. */
  file: string;
  fs: MemoryFs;
  documents: MemoryDocuments;
  /** Runs writes to the same file one after the other. */
  enqueue<T>(file: string, task: () => Promise<T>): Promise<T>;
  now(): Date;
  journal?: EditJournalWriter;
  secrets?: readonly string[];
  /** Called after a note was written. */
  onWrite(): void;
  /** Rejects when the file must not be used (a link or junction leads it outside the workspace folder). */
  guard?(): Promise<void>;
}

/**
 * The memory file of one run's folder. Reads an open editor's text first; appends dated bullets one at a time,
 * through the open editor when there is one (saved when it had no unsaved changes), after telling the edit journal
 * so the review card lists the change. Nothing is read or written while `guard` rejects.
 */
export function createProjectMemory(deps: ProjectMemoryDeps): ProjectMemory {
  const { file, fs, documents } = deps;
  const uri = vscode.Uri.file(file);

  const writeOpen = async (text: string) => {
    const doc = documents.find(uri);
    if (!doc) return false;
    const wasDirty = doc.isDirty;
    if (!(await documents.append(uri, text))) {
      throw new Error(`Could not change ${MEMORY_FILE}. Close its editor and try again.`);
    }
    if (!wasDirty && !(await doc.save())) {
      throw new Error(`Could not save ${MEMORY_FILE}. Save it in its editor.`);
    }
    return true;
  };

  return {
    async read() {
      await deps.guard?.();
      return documents.find(uri)?.getText() ?? (await fs.read(file));
    },

    append(note, io) {
      const problem = checkMemoryNote(note, deps.secrets ?? []);
      if (problem !== undefined) return Promise.reject(new Error(problem));
      return deps.enqueue(file, async () => {
        await deps.guard?.();
        const doc = documents.find(uri);
        const current = doc ? doc.getText() : await fs.read(file);
        if (current !== undefined && utf8Bytes(current) > MEMORY_FILE_MAX_BYTES) {
          throw new Error(MEMORY_TOO_LARGE);
        }
        const line = memoryNoteLine(note, deps.now());
        const next = appendMemoryNote(current, line);
        await deps.journal?.beforeWrite(file, io.stepId, doc?.isDirty ? current : undefined);
        const added =
          current !== undefined && next.startsWith(current) ? next.slice(current.length) : undefined;
        if (added === undefined || !(await writeOpen(added))) await fs.write(file, next);
        deps.onWrite();
        return line;
      });
    },
  };
}
