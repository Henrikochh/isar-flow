import packageJson from '../package.json';
import { type CliCommand, HELP_TEXT, parseCliArgs, UsageError } from './args';
import { CliError, errorMessage } from './errors';
import { EXIT_CANCELLED, EXIT_FAILURE, EXIT_SUCCESS, executeRun } from './execute';
import type { CliIo } from './io';
import { jsonFailure } from './json';
import { prepareRun } from './prepare';

/**
 * The `isar-flow` command line: `run <file> [--input name=value]… [--simulate] [--json] [--yes]`, `--help`,
 * `--version`. Resolves with the exit code: 0 success, 1 failure, 130 cancelled.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`${error.message}\nRun isar-flow --help to see the options.\n`);
    return EXIT_FAILURE;
  }
  if (command.kind === 'help') {
    io.stdout.write(HELP_TEXT);
    return EXIT_SUCCESS;
  }
  if (command.kind === 'version') {
    io.stdout.write(`${packageJson.version}\n`);
    return EXIT_SUCCESS;
  }

  try {
    const prepared = await prepareRun(command, io);
    if (io.signal?.aborted) return cancelledBeforeStart(io);
    return await executeRun(prepared, command, io);
  } catch (error) {
    if (io.signal?.aborted) return cancelledBeforeStart(io);
    const known = error instanceof CliError;
    const message = known ? error.message : `Unexpected error: ${errorMessage(error)}`;
    const details = known ? error.details : [];
    for (const line of details) io.stderr.write(`${line}\n`);
    io.stderr.write(`${message}\n`);
    if (command.json) {
      io.stdout.write(`${JSON.stringify(jsonFailure(message, undefined, details), null, 2)}\n`);
    }
    return EXIT_FAILURE;
  }
}

function cancelledBeforeStart(io: CliIo): number {
  io.stderr.write('Cancelled before the run started.\n');
  return EXIT_CANCELLED;
}
