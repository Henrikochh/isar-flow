import type { RunManagerDeps, WorkspaceAdapter } from '../contracts';
import { resolveInWorkspaceReal, WorkspacePathError } from '../tools/pathGuard';
import { errorMessage } from './format';

export const CONTEXT_LIMITS = {
  files: 20,
  /** Characters per file. */
  fileChars: 100 * 1024,
  /** Characters across all files. */
  totalChars: 400 * 1024,
};

const note = (text: string) => `\n[Isar Flow: ${text}]`;

/**
 * Builds `readContextFiles` for agent blocks: files matching workspace-relative globs, read once each, capped at
 * 20 files, 100 KB per file and 400 KB in total. Truncations are noted in the content the model sees.
 *
 * @param find workspace-relative paths (forward slashes) matching a glob, at most `max`
 * @param read text of a workspace-relative path
 */
export function createContextFileReader(
  find: (glob: string, max: number) => Promise<string[]>,
  read: (relPath: string) => Promise<string>,
): RunManagerDeps['readContextFiles'] {
  return async (globs, signal) => {
    const paths: string[] = [];
    const seen = new Set<string>();
    let moreMatched = false;
    for (const glob of globs) {
      signal.throwIfAborted();
      if (paths.length >= CONTEXT_LIMITS.files) {
        moreMatched = true;
        break;
      }
      for (const found of await find(glob, CONTEXT_LIMITS.files + 1)) {
        const relPath = found.replace(/\\/g, '/');
        if (seen.has(relPath)) continue;
        if (paths.length >= CONTEXT_LIMITS.files) {
          moreMatched = true;
          break;
        }
        seen.add(relPath);
        paths.push(relPath);
      }
    }

    const files: { path: string; content: string }[] = [];
    let total = 0;
    let skipped = 0;
    for (const relPath of paths) {
      signal.throwIfAborted();
      if (total >= CONTEXT_LIMITS.totalChars) {
        skipped++;
        continue;
      }
      let content: string;
      try {
        content = await read(relPath);
      } catch (error) {
        files.push({
          path: relPath,
          content: note(`this file could not be read: ${errorMessage(error)}`).trim(),
        });
        continue;
      }
      if (content.includes('\u0000')) {
        files.push({ path: relPath, content: note('binary file, not attached').trim() });
        continue;
      }
      let suffix = '';
      if (content.length > CONTEXT_LIMITS.fileChars) {
        content = content.slice(0, CONTEXT_LIMITS.fileChars);
        suffix = note('Truncated: only the first 100 KB of this file are attached.');
      }
      const room = CONTEXT_LIMITS.totalChars - total;
      if (content.length > room) {
        content = content.slice(0, room);
        suffix = note('Truncated: the 400 KB limit for context files was reached.');
      }
      total += content.length;
      files.push({ path: relPath, content: content + suffix });
    }

    const last = files[files.length - 1];
    if (last && (skipped > 0 || moreMatched)) {
      last.content += note(
        `${notAttached(skipped, moreMatched)} not attached (limits: ${CONTEXT_LIMITS.files} files, 400 KB).`,
      );
    }
    return files;
  };
}

/**
 * The context file reader for one workspace folder. File searches may follow links, so every file is read
 * only when its real path stays inside the folder: a link in the repository must not attach private files.
 */
export function createWorkspaceContextReader(
  root: string,
  files: Pick<WorkspaceAdapter, 'findFiles' | 'readFile' | 'realPath'>,
): RunManagerDeps['readContextFiles'] {
  return createContextFileReader(
    (glob, max) => files.findFiles(glob, max),
    async (relPath) => {
      let absPath: string;
      try {
        absPath = await resolveInWorkspaceReal(root, relPath, (p) => files.realPath(p));
      } catch (error) {
        if (!(error instanceof WorkspacePathError)) throw error;
        throw new Error('it is outside the workspace folder (through a symbolic link or junction)', {
          cause: error,
        });
      }
      return files.readFile(absPath);
    },
  );
}

function notAttached(skipped: number, moreMatched: boolean): string {
  if (skipped === 0) return 'More matching files were';
  if (moreMatched) return `At least ${skipped} more matching files were`;
  return skipped === 1 ? '1 more matching file was' : `${skipped} more matching files were`;
}
