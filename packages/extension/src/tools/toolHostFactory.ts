import type { ShellName, ToolHost } from '@isar-flow/core';
import type { PermissionPrompt, RunConsoleCommand, ToolHostFactory } from '../contracts';
import { createToolHost } from './toolHost';
import type { ToolWorkspace } from './types';

export const NO_FOLDER_TOOL_ERROR =
  'Agent tools need an open folder. Open a folder in VS Code and run again.';

export interface ToolHostFactoryDeps {
  /** The first workspace folder; undefined when no folder is open. */
  defaultRoot(): string | undefined;
  /** File access whose searches start in `root`. */
  workspace(root: string): ToolWorkspace;
  /** The `isarFlow.defaultShell` setting as it applies to `root`; an unknown value means 'auto'. */
  defaultShell(root: string): string;
  runCommand: RunConsoleCommand;
  prompt: PermissionPrompt;
}

const SHELLS: readonly ShellName[] = ['auto', 'pwsh', 'powershell', 'cmd', 'bash', 'sh'];

/** Used when no folder is open: agents still run, but every tool call explains why it was refused. */
const noFolderToolHost: ToolHost = {
  execute: async () => ({ isError: true, content: NO_FOLDER_TOOL_ERROR }),
};

/**
 * One host per run: "Allow for this run" lives in the host, and the root and shell are read at run start.
 * Every path, search and command of the host stays in `workspaceRoot` (the workflow's own folder in a
 * multi-root workspace, or the run's git worktree), or in the first folder when none is given. Runs pass
 * their edit journal in `options`; Try it passes none.
 */
export function createToolHostFactory(deps: ToolHostFactoryDeps): ToolHostFactory {
  return (runId, workspaceRoot, options) => {
    const root = workspaceRoot ?? deps.defaultRoot();
    if (!root) return noFolderToolHost;
    const configured = deps.defaultShell(root);
    return createToolHost({
      runId,
      workspaceRoot: root,
      workspace: deps.workspace(root),
      runCommand: deps.runCommand,
      prompt: deps.prompt,
      defaultShell: SHELLS.find((shell) => shell === configured) ?? 'auto',
      ...(options?.journal && { journal: options.journal }),
    });
  };
}
