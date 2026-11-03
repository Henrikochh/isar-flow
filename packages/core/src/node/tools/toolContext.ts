import type { ShellName, StepIO, ToolName, ToolResult } from '../../index';
import type { RunConsoleCommand, WorkspaceAdapter } from '../types';

/** A WorkspaceAdapter that may also report file sizes, so big files are skipped before they are read. */
export interface ToolWorkspace extends WorkspaceAdapter {
  fileSize?(absPath: string): Promise<number | undefined>;
  /** The text of an open editor with unsaved changes to the file (writes save it); undefined otherwise. */
  unsavedText?(absPath: string): string | undefined;
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
  /** Like displayPath, with links, junctions and short names resolved: where a write really lands. */
  realDisplayPath(absPath: string): Promise<string>;
  /** Resolves when the tool may go ahead; throws ToolError when the agent's permission or the user says no. */
  authorize(tool: ToolName, summary: string, detail?: string): Promise<void>;
}

/** Returns the content of a successful result, or a full result (e.g. an error that still carries output). */
export type ToolImpl = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolResult>;
