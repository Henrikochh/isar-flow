/**
 * A problem the user can fix (missing file, invalid workflow or config, missing input). Printed without a stack:
 * the `details` lines first (e.g. `file:line:col error …`), then the message. Exit code 1.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
