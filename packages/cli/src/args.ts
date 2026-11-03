import { parseArgs } from 'node:util';

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | {
      kind: 'run';
      /** As typed: a path relative to the current folder, or the name of a workflow in .isarflow/workflows. */
      file: string;
      inputs: Record<string, string>;
      simulate: boolean;
      json: boolean;
      yes: boolean;
    };

/** A command line the runner can't use; printed with a pointer to --help, exit code 1. */
export class UsageError extends Error {}

const INPUT_HINT = 'Use --input name=value.';
const RUN_HINT = 'Use isar-flow run <file>.';

export const HELP_TEXT = `Usage: isar-flow run <file> [options]

Runs an Isar Flow workflow in the terminal.

Arguments:
  <file>                Workflow file (.workflow.yaml), or the name of one in .isarflow/workflows

Options:
  --input name=value    Set a workflow input; repeat it for more inputs
  --simulate            Use the mock results of the simulation file; nothing is executed
  --json                Print one JSON result on stdout; progress goes to stderr
  --yes                 Approve approvals, use default answers and allow agent tools without asking
  -h, --help            Show this help
  --version             Show the version

Agent blocks use OpenAI-compatible providers from .isarflow/config.yaml, or from the environment
variables ISARFLOW_<PROVIDER>_BASE_URL and ISARFLOW_<PROVIDER>_API_KEY.
secrets.<name> reads the environment variable ISARFLOW_SECRET_<NAME>.

Not available on the command line: VS Code models (vscode/…) and user agents from VS Code. Copy
agent files into .isarflow/agents/. There is no MCP mode.

Exit codes: 0 success, 1 failure, 130 cancelled.
`;

const OPTIONS = {
  input: { type: 'string', multiple: true },
  simulate: { type: 'boolean' },
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

/** Reads `isar-flow run <file> [--input name=value]… [--simulate] [--json] [--yes]`, --help or --version. */
export function parseCliArgs(argv: string[]): CliCommand {
  const { values, positionals } = parse(argv);
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };
  const [command, ...files] = positionals;
  if (command === undefined) throw new UsageError(`Missing command. ${RUN_HINT}`);
  if (command !== 'run') throw new UsageError(`Unknown command '${command}'. ${RUN_HINT}`);
  if (files.length === 0)
    throw new UsageError('Pass the workflow file to run, e.g. isar-flow run fix-tests.');
  if (files.length > 1) {
    throw new UsageError(`Pass one workflow file; got ${files.map((file) => `'${file}'`).join(' and ')}.`);
  }
  return {
    kind: 'run',
    file: files[0],
    inputs: parseInputs(values.input ?? []),
    simulate: values.simulate ?? false,
    json: values.json ?? false,
    yes: values.yes ?? false,
  };
}

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(parseErrorMessage(error));
  }
}

/** parseArgs explains errors at length; the runner names the option and what to do. */
function parseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  const option = /'(-[^' ]*)/.exec(message)?.[1] ?? '';
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `Unknown option '${option}'.`;
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    if (option === '--input' || option === '-i') return `--input needs a value. ${INPUT_HINT}`;
    return `${option.replace(/[= ].*$/, '')} doesn't take a value.`;
  }
  return message;
}

function parseInputs(pairs: string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals < 0) throw new UsageError(`Missing '=' in --input ${pair}. ${INPUT_HINT}`);
    const name = pair.slice(0, equals).trim();
    if (name === '') throw new UsageError(`Missing name in --input ${pair}. ${INPUT_HINT}`);
    inputs[name] = pair.slice(equals + 1);
  }
  return inputs;
}
