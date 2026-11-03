import { execFile } from 'node:child_process';

/** Largest output read from one git command (snapshot files are read whole). */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * Settings every call gets: raw UTF-8 paths, long paths on Windows, and no hooks: snapshots and worktrees are
 * Isar Flow's own bookkeeping (update-ref would run reference-transaction hooks, worktree add post-checkout).
 */
const BASE_ARGS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'core.hooksPath=/dev/null',
  ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
];

export interface GitCallOptions {
  cwd: string;
  /** Added on top of process.env. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Written to stdin. */
  input?: Uint8Array;
}

/** Runs one git command and resolves with its stdout. */
export type GitRunner = (args: string[], options: GitCallOptions) => Promise<Buffer>;

export class GitError extends Error {
  constructor(
    message: string,
    /** The git executable could not be started. */
    readonly missing = false,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

interface ExecError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/** Variables that would point git at another repository or index than the one in `cwd`. */
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];

function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of INHERITED) delete env[name];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/** The subcommand, for messages (skips `-c name=value` options). */
const commandOf = (args: string[]) =>
  args.find((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-c') ?? 'git';

/** A git runner without a shell (execFile), with prompts and optional locks turned off. */
export function createGitRunner(gitPath = 'git'): GitRunner {
  return (args, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        gitPath,
        [...BASE_ARGS, ...args],
        {
          cwd: options.cwd,
          env: { ...baseEnv(), ...options.env },
          encoding: 'buffer',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          ...(options.timeoutMs !== undefined && { timeout: Math.max(1, Math.floor(options.timeoutMs)) }),
        },
        (error: ExecError | null, stdout: Buffer, stderr: Buffer) => {
          if (!error) return resolve(stdout);
          if (error.code === 'ENOENT') {
            return reject(new GitError(`git could not be started (${gitPath}): ${error.message}`, true));
          }
          if (error.killed || error.signal) {
            return reject(new GitError(`git ${commandOf(args)} took too long and was stopped.`, false, true));
          }
          const detail = stderr.toString('utf8').trim() || error.message;
          reject(new GitError(`git ${commandOf(args)} failed: ${detail}`));
        },
      );
      if (options.input !== undefined) child.stdin?.end(Buffer.from(options.input));
      else child.stdin?.end();
    });
}

/** Splits NUL-separated git output (-z), dropping the empty tail. */
export function splitNul(output: Buffer | string): string[] {
  const parts = output.toString('utf8').split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}
