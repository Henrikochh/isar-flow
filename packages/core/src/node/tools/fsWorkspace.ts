import fs from 'node:fs';
import path from 'node:path';
import { walkFiles } from './fsWalk';
import type { ToolWorkspace } from './toolContext';

/**
 * File access for agent tools straight on the file system (the command line runner): reads decode UTF-8, writes
 * create missing folders, searches walk `root` without node_modules and .git and without following linked folders.
 */
export function createFsWorkspaceAdapter(root: string): ToolWorkspace {
  return {
    readFile: async (absPath) => new TextDecoder('utf-8').decode(await fs.promises.readFile(absPath)),
    writeFile: async (absPath, content) => {
      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      await fs.promises.writeFile(absPath, content, 'utf8');
    },
    findFiles: (glob, max) => walkFiles(root, glob, max),
    realPath: (absPath) => fs.promises.realpath(absPath),
    exists: (absPath) =>
      fs.promises.stat(absPath).then(
        () => true,
        () => false,
      ),
    deleteFile: (absPath) => fs.promises.unlink(absPath),
    fileSize: (absPath) =>
      fs.promises.stat(absPath).then(
        (stat) => stat.size,
        () => undefined,
      ),
  };
}
