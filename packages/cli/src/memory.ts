import fs from 'node:fs';
import path from 'node:path';
import {
  appendMemoryNote,
  checkMemoryNote,
  decodeMemoryText,
  MEMORY_FILE,
  MEMORY_FILE_MAX_BYTES,
  memoryNoteLine,
  type ProjectMemory,
} from '@isar-flow/core';
import { memoryFileInside } from '@isar-flow/core/node';
import { CliError, errorMessage } from './errors';

/** The memory file's text; undefined when it does not exist. Throws MEMORY_NOT_TEXT for files that aren't UTF-8. */
async function readMemoryFile(file: string): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError(`Could not read ${file}: ${errorMessage(error)}`);
  }
  return decodeMemoryText(bytes);
}

/** Same wording as in VS Code: the agent reads it as the result of its remember call. */
const MEMORY_TOO_LARGE = `The project memory is over 64 KB. Ask the user to tidy ${MEMORY_FILE}.`;

export interface FsProjectMemoryOptions {
  now?: () => Date;
  /** Secret values of the run; notes that contain one are refused. */
  secrets?: readonly string[];
}

/**
 * The project memory (`<root>/.isarflow/memory.md`) of a command line run, in the same format as in VS Code:
 * notes are appended as dated bullets, one write at a time, and the file is created with its header when missing.
 * A memory file that a link or junction leads outside the folder is neither read nor written.
 */
export function createFsProjectMemory(root: string, options: FsProjectMemoryOptions = {}): ProjectMemory {
  const now = options.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();

  const write = async (note: string): Promise<string> => {
    const file = await memoryFileInside(root);
    const current = await readMemoryFile(file);
    if (current !== undefined && Buffer.byteLength(current, 'utf8') > MEMORY_FILE_MAX_BYTES) {
      throw new Error(MEMORY_TOO_LARGE);
    }
    const line = memoryNoteLine(note, now());
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, appendMemoryNote(current, line), 'utf8');
    return line;
  };

  return {
    read: async () => readMemoryFile(await memoryFileInside(root)),
    append(note) {
      const problem = checkMemoryNote(note, options.secrets ?? []);
      if (problem !== undefined) return Promise.reject(new Error(problem));
      const result = queue.then(() => write(note));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
