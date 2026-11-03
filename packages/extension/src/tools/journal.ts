import type { EditJournalWriter } from '../contracts';
import type { ToolWorkspace } from './types';

/**
 * The workspace one tool call uses during a run: the run's edit journal hears about every write and delete
 * first (it reads the original from disk itself, or gets the unsaved text of an open editor, which the write
 * saves), reads pass straight through.
 */
export function journaledWorkspace(
  workspace: ToolWorkspace,
  journal: EditJournalWriter,
  stepId: string,
): ToolWorkspace {
  const { deleteFile, fileSize, unsavedText } = workspace;
  const record = (absPath: string) => {
    const unsaved = unsavedText?.call(workspace, absPath);
    return unsaved === undefined
      ? journal.beforeWrite(absPath, stepId)
      : journal.beforeWrite(absPath, stepId, unsaved);
  };
  return {
    readFile: (absPath) => workspace.readFile(absPath),
    findFiles: (glob, max) => workspace.findFiles(glob, max),
    realPath: (absPath) => workspace.realPath(absPath),
    exists: (absPath) => workspace.exists(absPath),
    ...(fileSize && { fileSize: (absPath: string) => fileSize.call(workspace, absPath) }),
    ...(unsavedText && { unsavedText: (absPath: string) => unsavedText.call(workspace, absPath) }),
    writeFile: async (absPath, content) => {
      await record(absPath);
      return workspace.writeFile(absPath, content);
    },
    ...(deleteFile && {
      deleteFile: async (absPath: string) => {
        await record(absPath);
        return deleteFile.call(workspace, absPath);
      },
    }),
  };
}
