/**
 * Entry of the `isar-flow` binary (bundled to dist/cli.js): wires the process (arguments, streams, environment,
 * signals, exit code) to runCli, where the logic lives.
 */
import { errorMessage } from './errors';
import { runCli } from './run';
import { createInterruptHandler } from './signals';

const flush = (stream: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => stream.write('', () => resolve()));

async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = createInterruptHandler({
    abort: () => controller.abort(),
    write: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  let code: number;
  try {
    code = await runCli(process.argv.slice(2), {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      env: process.env,
      cwd: process.cwd(),
      signal: controller.signal,
    });
  } catch (error) {
    process.stderr.write(`Unexpected error: ${errorMessage(error)}\n`);
    code = 1;
  }
  // Pipes are written asynchronously; exit once everything is out (stdin may still hold the process open).
  await flush(process.stdout);
  await flush(process.stderr);
  process.exit(code);
}

void main();
