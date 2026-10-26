import path from 'node:path';
import { isToolName, TOOL_NAMES, type ToolHost, type ToolName, type ToolResult } from '@isar-flow/core';
import type { ToolHostOptions } from '../contracts';
import { abortError, throwIfAborted } from './abort';
import { gitDiff, runCommand } from './commandTools';
import { editFile, writeFile } from './editTools';
import { resolveInWorkspaceReal } from './pathGuard';
import { PermissionGate } from './permissions';
import { listFiles, readFile, searchText } from './readTools';
import type { ToolContext, ToolImpl, ToolWorkspace } from './types';

const TOOLS: Record<ToolName, ToolImpl> = {
  readFile,
  listFiles,
  searchText,
  gitDiff,
  editFile,
  writeFile,
  runCommand,
};

/**
 * Executes the built-in agent tools inside one workspace folder. Every failure comes back as an error
 * result for the model; only an aborted run (io.signal) rejects. "Allow for this run" answers live as long
 * as this host, so create one host per run.
 */
export function createToolHost(options: ToolHostOptions & { runId: string }): ToolHost {
  const root = path.resolve(options.workspaceRoot);
  const workspace: ToolWorkspace = options.workspace;
  const gate = new PermissionGate(options.runId, options.prompt);
  // searchText checks every file, so the root's real path is looked up once per host.
  let realRoot: Promise<string> | undefined;
  const realPath = (absPath: string) =>
    absPath === root ? (realRoot ??= workspace.realPath(root)) : workspace.realPath(absPath);

  return {
    async execute(call, io, permissions): Promise<ToolResult> {
      throwIfAborted(io.signal);
      if (!isToolName(call.name)) {
        return {
          isError: true,
          content: `Unknown tool "${call.name}". Available tools: ${TOOL_NAMES.join(', ')}.`,
        };
      }
      const ctx: ToolContext = {
        root,
        workspace,
        io,
        defaultShell: options.defaultShell,
        runCommand: options.runCommand,
        resolvePath: (input) => resolveInWorkspaceReal(root, input, realPath),
        displayPath: (absPath) => path.relative(root, absPath).split(path.sep).join('/') || '.',
        authorize: (tool, summary, detail) => gate.authorize(tool, permissions, io, summary, detail),
      };
      try {
        const result = await TOOLS[call.name](call.args ?? {}, ctx);
        return typeof result === 'string' ? { content: result } : result;
      } catch (error) {
        if (io.signal.aborted) throw abortError(io.signal);
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
