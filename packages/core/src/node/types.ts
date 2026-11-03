/**
 * Types of the Node-only part of core (`@isar-flow/core/node`): the console runner, the agent tool host and the
 * git capture, shared by the VS Code extension and the command line runner. Nothing in the core main entry (and
 * so nothing in the webviews) may import from `src/node`.
 */
import type { ToolHost } from '../agent/types';
import type { ConsoleResult, GitContext } from '../engine/types';
import type { ShellName, ToolName } from '../schema/types';

/* ---------- console runner ---------- */

export interface ConsoleRunOptions {
  command: string;
  shell: ShellName;
  /** Absolute working directory. */
  cwd: string;
  /** Added on top of process.env. */
  env: Record<string, string>;
  timeoutMs?: number;
  signal: AbortSignal;
  onData(stream: 'stdout' | 'stderr', text: string): void;
}

/** Spawns the command in the resolved shell, captures output (UTF-8), kills the process tree on abort/timeout. */
export type RunConsoleCommand = (options: ConsoleRunOptions) => Promise<ConsoleResult>;

export interface ResolvedShell {
  /** Executable, e.g. 'pwsh.exe', 'powershell.exe', 'cmd.exe', '/bin/bash'. */
  file: string;
  args(command: string): string[];
  label: string;
}

/* ---------- agent tools ---------- */

/**
 * File access used by the tool host. The VS Code implementation applies edits via WorkspaceEdit (undoable); the
 * command line implementation uses the file system.
 */
export interface WorkspaceAdapter {
  readFile(absPath: string): Promise<string>;
  /** Creates or overwrites a file. */
  writeFile(absPath: string, content: string): Promise<void>;
  /** Workspace-relative paths (forward slashes) matching the glob, excluding node_modules/.git, at most `max`. */
  findFiles(glob: string, max: number): Promise<string[]>;
  /** Resolves symlinks; rejects when the path does not exist. */
  realPath(absPath: string): Promise<string>;
  exists(absPath: string): Promise<boolean>;
  /** Deletes a file (an undoable workspace edit in VS Code); used by applyPatch for "+++ /dev/null". */
  deleteFile?(absPath: string): Promise<void>;
}

/**
 * Receives agent writes from the tool host for the run's edit journal (review card: which block changed which
 * file; the original content when the folder has no git).
 */
export interface EditJournalWriter {
  /**
   * Called before an agent tool creates, changes or deletes `absPath`. The journal reads the file as it is on disk
   * now, but only the first time per file and run. `unsaved` is the text of an editor with unsaved changes to the
   * file: the write saves it, so it is kept instead. Never rejects: storage problems are logged.
   */
  beforeWrite(absPath: string, stepId: string, unsaved?: string): Promise<void>;
}

/** Per-run extras of a tool host. */
export interface ToolHostRunOptions {
  /** Records agent writes; omitted for Try it and the command line. */
  journal?: EditJournalWriter;
}

export interface PermissionRequest {
  runId: string;
  stepId: string;
  tool: ToolName;
  /** One line, e.g. "Edit src/app.ts" or "Run: npm test". */
  summary: string;
  detail?: string;
}

/** 'allowRun' allows this tool for the rest of the run. */
export type PermissionAnswer = 'allow' | 'allowRun' | 'deny';

/** Asks whether an agent may use a tool whose permission is `ask` (a VS Code modal, or the terminal). */
export type PermissionPrompt = (request: PermissionRequest) => Promise<PermissionAnswer>;

export interface ToolHostOptions {
  workspaceRoot: string;
  workspace: WorkspaceAdapter;
  runCommand: RunConsoleCommand;
  prompt: PermissionPrompt;
  defaultShell: ShellName;
  /** Told about every agent write before it happens (runs only). */
  journal?: EditJournalWriter;
}

/**
 * Creates a tool host whose "allow for this run" answers are scoped to `runId`. `workspaceRoot` is the
 * folder of the workflow being run (multi-root workspaces) or the run's git worktree; defaults to the first
 * workspace folder. Roots outside the workspace folders (worktrees in extension storage) must work too.
 */
export type ToolHostFactory = (
  runId: string,
  workspaceRoot?: string,
  options?: ToolHostRunOptions,
) => ToolHost;

/* ---------- git context (expression root `git`) ---------- */

export interface GitCaptureOptions {
  signal?: AbortSignal;
  /** Cap of `diff` in UTF-8 bytes (default 100 KB). */
  maxDiffBytes?: number;
  /** Per git call (default 5 s); a call that takes longer leaves its field empty. */
  timeoutMs?: number;
  /** git executable (default "git" on the PATH). */
  gitPath?: string;
}

/**
 * Captures `git.*` for a workspace folder with `execFile` (never a shell). Never rejects: outside a repository,
 * without git, or when a call fails, the affected fields are empty.
 */
export type CaptureGitContext = (root: string, options?: GitCaptureOptions) => Promise<GitContext>;
