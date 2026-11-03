import fs from 'node:fs';
import { MEMORY_FILE } from '../../index';
import { resolveInWorkspaceReal, WorkspacePathError } from './pathGuard';

export const MEMORY_OUTSIDE = `${MEMORY_FILE} leads outside the workspace folder through a symbolic link or junction, so it isn't used.`;

/**
 * Absolute path of the project memory of `root`, once its real path (links, junctions) is known to stay inside the
 * real workspace folder. A repository could otherwise point the file at any file of the user: agents would send it
 * to their model, and remember would append to it.
 */
export async function memoryFileInside(root: string): Promise<string> {
  try {
    return await resolveInWorkspaceReal(root, MEMORY_FILE, (absPath) => fs.promises.realpath(absPath));
  } catch (error) {
    if (error instanceof WorkspacePathError) throw new Error(MEMORY_OUTSIDE, { cause: error });
    throw error;
  }
}
