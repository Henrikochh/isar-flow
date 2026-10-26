import { throwIfAborted } from './abort';
import { booleanArg, requiredString, stringArg } from './args';
import { clip, firstLine, KB, tailText, truncateUtf8 } from './text';
import { ToolError, type ToolImpl } from './types';

const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_TAIL_CHARS = 20 * KB;
const GIT_TIMEOUT_MS = 60_000;
const DIFF_LIMIT_BYTES = 200 * KB;

export const gitDiff: ToolImpl = async (args, ctx) => {
  const staged = booleanArg(args, 'staged') ?? false;
  // --no-ext-diff/--no-color keep user configuration (difftools, color.ui=always) out of the output.
  const command = `git diff${staged ? ' --staged' : ''} --no-color --no-ext-diff`;
  const result = await ctx.runCommand({
    command,
    shell: ctx.defaultShell,
    cwd: ctx.root,
    env: {},
    timeoutMs: GIT_TIMEOUT_MS,
    signal: ctx.io.signal,
    onData: () => undefined,
  });
  throwIfAborted(ctx.io.signal);
  if (result.timedOut) throw new ToolError(`git diff did not finish within ${GIT_TIMEOUT_MS / 1000} s.`);
  if (result.exitCode !== 0) {
    const reason = clip((result.stderr || result.output).trim(), 2000) || 'no output';
    throw new ToolError(`git diff failed (exit code ${result.exitCode}): ${reason}`);
  }
  if (result.stdout.trim() === '') return staged ? 'No staged changes.' : 'No unstaged changes.';
  const { text, truncated } = truncateUtf8(result.stdout, DIFF_LIMIT_BYTES);
  return truncated ? `${text}\n[Truncated at 200 KB. Read the changed files for the rest.]` : text;
};

export const runCommand: ToolImpl = async (args, ctx) => {
  const command = requiredString(args, 'command');
  if (command.trim() === '') throw new ToolError('"command" is empty. Pass the command line to run.');
  const cwdInput = stringArg(args, 'cwd');
  const cwd = cwdInput === undefined || cwdInput.trim() === '' ? ctx.root : await ctx.resolvePath(cwdInput);
  const folder = ctx.displayPath(cwd);
  await ctx.authorize(
    'runCommand',
    `Run: ${firstLine(command, 100)}`,
    `${clip(command, 2000)}\n\nFolder: ${folder === '.' ? 'workspace root' : folder}`,
  );

  const result = await ctx.runCommand({
    command,
    shell: ctx.defaultShell,
    cwd,
    env: {},
    timeoutMs: COMMAND_TIMEOUT_MS,
    signal: ctx.io.signal,
    onData: (stream, text) => ctx.io.log(stream, text),
  });
  throwIfAborted(ctx.io.signal);
  const output = tailText(result.output, COMMAND_TAIL_CHARS) || '(no output)';
  if (result.timedOut) {
    return {
      isError: true,
      content:
        `Timed out after ${COMMAND_TIMEOUT_MS / 1000} s and was stopped (exit code ${result.exitCode}). ` +
        `Do not start servers, watchers or interactive programs.\n${output}`,
    };
  }
  return `exit code ${result.exitCode}\n${output}`;
};
