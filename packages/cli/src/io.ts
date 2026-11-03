import type { CaptureGitContext, RunConsoleCommand } from '@isar-flow/core/node';

export interface CliOutput {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface CliInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
}

/**
 * Everything runCli uses from the process; index.ts passes the real process, tests pass streams and fakes. The
 * optional members default to the real implementations.
 */
export interface CliIo {
  stdout: CliOutput;
  stderr: CliOutput;
  /** Prompts read answers from here; without a terminal (`isTTY`) nobody is asked. */
  stdin: CliInput;
  env: Record<string, string | undefined>;
  cwd: string;
  /**
   * Aborts on the first Ctrl+C or SIGTERM: the run is cancelled and runCli resolves with 130. Prompts read the
   * terminal line by line (no raw mode), so Ctrl+C during a prompt is a SIGINT as well.
   */
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  now?(): number;
  runCommand?: RunConsoleCommand;
  captureGit?: CaptureGitContext;
  /** Top-level folder of the git repository that contains `folder`; undefined outside one. */
  gitTopLevel?(folder: string): Promise<string | undefined>;
  fetch?: typeof fetch;
}
