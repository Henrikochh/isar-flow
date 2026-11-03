import type { ShellName } from '@isar-flow/core';
import type { RunConsoleCommand, RunTerminal } from '../contracts';
import { dim, errorMessage, formatDuration, green, red, toTerminalText } from './format';

export interface SetupCommandOptions {
  commands: string[];
  /** The run's folder in its worktree. */
  cwd: string;
  shell: ShellName;
  runCommand: RunConsoleCommand;
  terminal: RunTerminal;
  signal: AbortSignal;
  now?: () => number;
}

export type SetupOutcome = { cancelled: true } | { error: string } | undefined;

/**
 * Runs the `setup` commands of a worktree run one after the other, mirrored to the run terminal like console
 * blocks. Resolves with undefined when all succeeded, else with why the run must stop.
 */
export async function runSetupCommands(options: SetupCommandOptions): Promise<SetupOutcome> {
  const { terminal, signal } = options;
  const now = options.now ?? Date.now;
  for (const [index, command] of options.commands.entries()) {
    if (signal.aborted) return { cancelled: true };
    if (index === 0) terminal.show(true);
    terminal.write(`${dim('▶ setup:')} ${toTerminalText(command)}\r\n`);
    let atLineStart = true;
    const startedAt = now();
    const footer = (text: string) =>
      terminal.write(`${atLineStart ? '' : '\r\n'}${text} · ${formatDuration(now() - startedAt)}\r\n\r\n`);
    try {
      const result = await options.runCommand({
        command,
        shell: options.shell,
        cwd: options.cwd,
        env: {},
        signal,
        onData(_stream, text) {
          if (text === '') return;
          terminal.write(toTerminalText(text));
          atLineStart = text.endsWith('\n');
        },
      });
      if (signal.aborted) {
        footer(red('✗ cancelled'));
        return { cancelled: true };
      }
      if (result.exitCode !== 0 || result.timedOut) {
        footer(red(`✗ exit ${result.exitCode}`));
        return {
          error: `Setup command "${command}" failed with exit code ${result.exitCode}. See the terminal for its output.`,
        };
      }
      footer(green('✓ exit 0'));
    } catch (error) {
      if (signal.aborted) return { cancelled: true };
      const message = errorMessage(error);
      footer(red(`✗ ${message}`));
      return { error: `Setup command "${command}" could not run: ${message.replace(/[.!?]$/, '')}.` };
    }
  }
  return undefined;
}
