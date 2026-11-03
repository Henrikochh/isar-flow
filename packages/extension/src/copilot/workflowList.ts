import * as vscode from 'vscode';
import { parseWorkflowText, type Workflow, type WorkflowInput, type WorkflowSummary } from '@isar-flow/core';
import { isExposed } from './lookup';
import { inlineCode, plainText } from './markdown';

/** An exposed, valid workflow with its current definition (null when the file can't be read now). */
export interface CopilotWorkflow {
  summary: WorkflowSummary;
  workflow: Workflow | null;
}

export interface CopilotWorkflows {
  /** Exposed and valid: Copilot may run them. */
  available: CopilotWorkflow[];
  /** Exposed, but the file has problems. */
  broken: WorkflowSummary[];
  /** Workflows that are not exposed. */
  others: number;
  total: number;
}

const NO_WORKFLOWS =
  'This workspace has no Isar Flow workflows yet. Create one with Isar Flow: New workflow, then set expose: true in it so Copilot can run it.';

/** Reads the workflows Copilot may see from the index and their files. */
export async function loadCopilotWorkflows(
  list: WorkflowSummary[],
  readText: (uri: vscode.Uri) => Promise<string>,
): Promise<CopilotWorkflows> {
  const exposed = list.filter(isExposed);
  const available = await Promise.all(
    exposed
      .filter((summary) => summary.valid)
      .map(async (summary): Promise<CopilotWorkflow> => {
        const text = await readText(vscode.Uri.parse(summary.uri)).catch(() => undefined);
        return { summary, workflow: text === undefined ? null : parseWorkflowText(text).workflow };
      }),
  );
  return {
    available,
    broken: exposed.filter((summary) => !summary.valid),
    others: list.length - exposed.length,
    total: list.length,
  };
}

function inputLine(name: string, input: WorkflowInput): string {
  const facts: string[] = [typeof input.type === 'string' ? input.type : 'string'];
  if (input.required === true) facts.push('required');
  if (input.default !== undefined) facts.push(`default: ${inlineCode(String(input.default))}`);
  const description =
    typeof input.description === 'string' && input.description.trim() !== ''
      ? `: ${plainText(input.description)}`
      : '';
  return `  - ${inlineCode(name)} (${facts.join(', ')})${description}`;
}

function workflowLines({ summary, workflow }: CopilotWorkflow): string[] {
  const lines = [`- **${plainText(summary.name)}** (${inlineCode(summary.relativePath)})`];
  const description = workflow?.description ?? summary.description;
  if (typeof description === 'string' && description.trim() !== '') lines.push(`  ${plainText(description)}`);
  const inputs = Object.entries(workflow?.inputs ?? {});
  if (inputs.length === 0) lines.push('  No inputs.');
  else lines.push('  Inputs:', ...inputs.map(([name, input]) => inputLine(name, input)));
  return lines;
}

/** Markdown for Copilot and `@isarflow /list`: what may run, with paths, descriptions and inputs. */
export function workflowListMarkdown(workflows: CopilotWorkflows): string {
  const { available, broken, others, total } = workflows;
  if (total === 0) return NO_WORKFLOWS;
  if (available.length === 0 && broken.length === 0) {
    return (
      'No workflow is available to Copilot yet. To allow one, set expose: true in its workflow file (or turn on ' +
      `'Let Copilot run this workflow' in its workflow settings). This workspace has ${total} ` +
      `${total === 1 ? 'workflow' : 'workflows'}.`
    );
  }
  const sections: string[] = [];
  if (available.length > 0) {
    sections.push(['Workflows Copilot may run:', '', ...available.flatMap(workflowLines)].join('\n'));
  }
  for (const summary of broken) {
    sections.push(
      `**${plainText(summary.name)}** (${inlineCode(summary.relativePath)}) has problems: fix them before Copilot can run it.`,
    );
  }
  if (others > 0) {
    sections.push(
      others === 1
        ? "1 other workflow isn't available to Copilot (set expose: true in a workflow to allow it)."
        : `${others} other workflows aren't available to Copilot (set expose: true in a workflow to allow it).`,
    );
  }
  return sections.join('\n\n');
}
