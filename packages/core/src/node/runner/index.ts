/**
 * Console runner shared by the extension and the command line runner (moved from packages/extension/src/runner by
 * Package C module "cli"): createConsoleRunner, runConsoleCommand, resolveShell, killProcessTree, …
 */
export { CappedText, MAX_CAPTURE_CHARS } from './capture';
export {
  type ConsoleRunnerDeps,
  createConsoleRunner,
  EXIT_CODE_ABORTED,
  EXIT_CODE_TIMEOUT,
  runConsoleCommand,
} from './consoleRunner';
export { commandEnv, envValue, mergeEnv } from './env';
export { killProcessTree } from './killTree';
export { resolveShell, type ResolveShellOptions, type ShellCommand } from './shells';
export { StreamDecoder } from './streamDecoder';
export {
  formatCommandHeader,
  formatDuration,
  formatExitFooter,
  startsOnNewLine,
  toTerminalText,
} from './terminalFormat';
export { findExecutable } from './which';
