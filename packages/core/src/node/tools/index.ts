/**
 * Agent tool host shared by the extension and the command line runner (moved from packages/extension/src/tools by
 * Package C module "cli"), plus the file-system WorkspaceAdapter of the command line.
 */
export {
  CONTEXT_LIMITS,
  createContextFileReader,
  createWorkspaceContextReader,
  type ReadContextFiles,
} from './contextFiles';
export { walkFiles } from './fsWalk';
export { createFsWorkspaceAdapter } from './fsWorkspace';
export { globMatcher } from './glob';
export { MEMORY_OUTSIDE, memoryFileInside } from './memoryPath';
export {
  type RealPathOptions,
  realRelativePath,
  resolveInWorkspace,
  resolveInWorkspaceReal,
  WorkspacePathError,
} from './pathGuard';
export { type ToolContext, ToolError, type ToolImpl, type ToolWorkspace } from './toolContext';
export { createToolHost } from './toolHost';
export { createToolHostFactory, NO_FOLDER_TOOL_ERROR, type ToolHostFactoryDeps } from './toolHostFactory';
