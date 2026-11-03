import {
  type Diagnostic,
  parseWorkflowText,
  type ValidateOptions,
  validateWorkflow,
  type Workflow,
} from '@isar-flow/core';
import { errorSummary, formatDiagnostic } from './diagnostics';
import { CliError } from './errors';
import { locateDiagnostic } from './locate';
import { secretEnvName } from './secrets';

const USER_AGENTS_NOTE =
  "User agents from VS Code aren't available on the command line. Copy the agent file into .isarflow/agents/.";

/** The VS Code wording ("Store the secret") names the environment variable on the command line. */
function cliMessage(diagnostic: Diagnostic): string {
  if (diagnostic.code !== 'unknown-secret') return diagnostic.message;
  const name = /^secrets\.(\S+) /.exec(diagnostic.message)?.[1];
  const vscodeText = 'is not a stored secret. Store the secret or fix the name.';
  if (!name || !diagnostic.message.includes(vscodeText)) return diagnostic.message;
  return diagnostic.message.replace(
    vscodeText,
    `isn't set. Set the environment variable ${secretEnvName(name)} or fix the name.`,
  );
}

/**
 * Parses and validates a workflow file. Throws a CliError listing the errors; returns the workflow and the warnings
 * as printable lines (info diagnostics are left out: they are hints for the editor).
 */
export function checkWorkflow(
  text: string,
  display: string,
  options: ValidateOptions,
): { workflow: Workflow; warnings: string[] } {
  const parsed = parseWorkflowText(text);
  const diagnostics = [...parsed.diagnostics];
  if (parsed.workflow && parsed.valid) {
    const semantic = validateWorkflow(parsed.workflow, options);
    diagnostics.push(...semantic.map((d) => locateDiagnostic(d, text, parsed.stepRanges)));
  }
  if (!parsed.workflow && !diagnostics.some((d) => d.severity === 'error')) {
    diagnostics.push({ severity: 'error', code: 'empty', message: 'The file has no workflow in it.' });
  }
  const lines = (severity: Diagnostic['severity']) =>
    diagnostics
      .filter((d) => d.severity === severity)
      .map((d) => formatDiagnostic(display, d, cliMessage(d)));
  const errors = lines('error');
  if (errors.length > 0 || !parsed.workflow || !parsed.valid) {
    const notes = diagnostics.some((d) => d.code === 'unknown-agent') ? [USER_AGENTS_NOTE] : [];
    throw new CliError(errorSummary('The workflow', Math.max(errors.length, 1)), [
      ...errors,
      ...lines('warning'),
      ...notes,
    ]);
  }
  return { workflow: parsed.workflow, warnings: lines('warning') };
}
