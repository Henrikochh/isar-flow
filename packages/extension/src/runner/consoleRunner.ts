import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { ConsoleResult, ShellName } from '@isar-flow/core';
import type { ConsoleRunOptions, RunConsoleCommand } from '../contracts';
import { CappedText } from './capture';
import { mergeEnv } from './env';
import { killProcessTree } from './killTree';
import { resolveShell, type ShellCommand } from './shells';
import { StreamDecoder } from './streamDecoder';

export const EXIT_CODE_TIMEOUT = 124;
export const EXIT_CODE_ABORTED = 130;

/** After the shell exited, how long to wait for pipes that a background process may still hold open. */
const CLOSE_GRACE_MS = 1000;
/** After killing the tree, resolve at the latest after this long even if the process did not exit. */
const ABORT_GRACE_MS = 500;
const TIMEOUT_GRACE_MS = 3000;

export interface ConsoleRunnerDeps {
  resolveShell?: (shell: ShellName) => ShellCommand;
  killTree?: (pid: number) => Promise<void>;
}

/** Builds a runner; tests inject the shell resolution, the extension uses `runConsoleCommand`. */
export function createConsoleRunner(deps: ConsoleRunnerDeps = {}): RunConsoleCommand {
  const resolve = deps.resolveShell ?? ((shell: ShellName) => resolveShell(shell));
  const killTree = deps.killTree ?? killProcessTree;
  return async (options) => {
    const shell = resolve(options.shell);
    await assertWorkingFolder(options.cwd);
    if (options.signal.aborted) return emptyResult(EXIT_CODE_ABORTED);
    return execute(shell, options, killTree);
  };
}

export const runConsoleCommand: RunConsoleCommand = createConsoleRunner();

type Stream = 'stdout' | 'stderr';
type StopReason = 'timeout' | 'abort';

function execute(
  shell: ShellCommand,
  options: ConsoleRunOptions,
  killTree: (pid: number) => Promise<void>,
): Promise<ConsoleResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(shell.file, shell.args(options.command), {
        cwd: options.cwd,
        env: mergeEnv(process.env, options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: shell.windowsVerbatimArguments,
        // POSIX: own process group so the whole tree can be signalled. Windows uses taskkill /T instead;
        // detaching there would leave grandchildren without a console (visible windows).
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      reject(startError(shell, error));
      return;
    }

    const captured = { stdout: new CappedText(), stderr: new CappedText() };
    const output = new CappedText();
    const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    let stopReason: StopReason | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

    const emit = (stream: Stream, text: string) => {
      if (text === '') return;
      captured[stream].append(text);
      output.append(text);
      try {
        options.onData(stream, text);
      } catch {
        // A failing listener must not cost the captured output.
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => emit('stdout', decoders.stdout.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => emit('stderr', decoders.stderr.write(chunk)));

    const cleanup = () => {
      for (const timer of timers) clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      emit('stdout', decoders.stdout.end());
      emit('stderr', decoders.stderr.end());
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode: exitCodeOf(stopReason, exit),
        stdout: captured.stdout.toString(),
        stderr: captured.stderr.toString(),
        output: output.toString(),
        timedOut: stopReason === 'timeout',
      });
    };
    const stop = (reason: StopReason) => {
      if (settled || stopReason || exit) return;
      stopReason = reason;
      if (child.pid !== undefined) void killTree(child.pid).catch(() => undefined);
      timers.push(setTimeout(finish, reason === 'abort' ? ABORT_GRACE_MS : TIMEOUT_GRACE_MS));
    };
    function onAbort() {
      if (exit) finish();
      else stop('abort');
    }

    child.on('error', (error) => {
      if (settled || child.pid !== undefined) return;
      settled = true;
      cleanup();
      reject(startError(shell, error));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      exit = { code, signal };
      timers.push(setTimeout(finish, CLOSE_GRACE_MS));
    });
    child.once('close', finish);
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timers.push(setTimeout(() => stop('timeout'), options.timeoutMs));
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function exitCodeOf(
  stopReason: StopReason | undefined,
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined,
): number {
  if (stopReason === 'timeout') return EXIT_CODE_TIMEOUT;
  if (stopReason === 'abort') return EXIT_CODE_ABORTED;
  if (exit?.code !== null && exit?.code !== undefined) return exit.code;
  if (exit?.signal) return 128 + (os.constants.signals[exit.signal] ?? 0);
  return 1;
}

async function assertWorkingFolder(cwd: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(cwd);
  } catch {
    throw new Error(`Working folder not found: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new Error(`Working folder is a file, not a folder: ${cwd}`);
}

function startError(shell: ShellCommand, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Could not start ${shell.label} (${shell.file}): ${reason}. ` +
      'Choose another shell for the block or change the isarFlow.defaultShell setting.',
  );
}

function emptyResult(exitCode: number): ConsoleResult {
  return { exitCode, stdout: '', stderr: '', output: '', timedOut: false };
}
