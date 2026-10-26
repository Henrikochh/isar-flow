import type { ShellName, StepIO, ToolName, ToolResult } from '@isar-flow/core';
import type { RunConsoleCommand, WorkspaceAdapter } from '../contracts';

/** A WorkspaceAdapter that may also report file sizes, so big files are skipped before they are read. */
export interface ToolWorkspace extends WorkspaceAdapter {
  fileSize?(absPath: string): Promise<number | undefined>;
}

/** A failure the model should read as the tool result (wrong arguments, missing file, refused permission). */
export class ToolError extends Error {}

/** What a tool implementation gets for one call. */
export interface ToolContext {
  root: string;
  workspace: ToolWorkspace;
  io: StepIO;
  defaultShell: ShellName;
  runCommand: RunConsoleCommand;
  /** Absolute path for a workspace path; follows links and throws when it leads outside the workspace. */
  resolvePath(input: string): Promise<string>;
  /** Workspace-relative path with forward slashes ('.' for the root). */
  displayPath(absPath: string): string;
  /** Resolves when the tool may go ahead; throws ToolError when the agent's permission or the user says no. */
  authorize(tool: ToolName, summary: string, detail?: string): Promise<void>;
}

/** Returns the content of a successful result, or a full result (e.g. an error that still carries output). */
export type ToolImpl = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolResult>;
