import * as vscode from 'vscode';
import { walkSteps, type Workflow } from '@isar-flow/core';
import { consoleCommandsOf } from '../run/commandApproval';
import {
  type CopilotDeps,
  type CopilotServices,
  prepareCopilotRun,
  type PreparedCopilotRun,
  runForCopilot,
} from './copilotRun';
import { codeBlock, inlineCode, plainText } from './markdown';
import { loadCopilotWorkflows, workflowListMarkdown } from './workflowList';

export const LIST_WORKFLOWS_TOOL = 'isarflow_listWorkflows';
export const RUN_WORKFLOW_TOOL = 'isarflow_runWorkflow';

export interface RunWorkflowInput {
  workflow: string;
  inputs?: Record<string, unknown>;
}

const NO_WORKFLOW = 'Name the workflow to run, as listed by isarflow_listWorkflows.';
const MAX_VALUE_CHARS = 200;
const INPUTS_IN_COMMANDS =
  "Copilot's input values become part of these commands as they are. Check them above.";
const INPUT_TEMPLATE = /\$\{\{[^}]*\binputs\b/;

/** Whether a console block pastes an input value into its command line (`env` is the safe way to pass it). */
function commandsUseInputs(workflow: Workflow): boolean {
  let found = false;
  walkSteps(workflow.steps ?? [], ({ step }) => {
    if (step.type === 'console' && typeof step.run === 'string' && INPUT_TEMPLATE.test(step.run))
      found = true;
  });
  return found;
}

const textResult = (text: string) =>
  new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

/**
 * An input value as inline code on one line: text with line breaks or control characters is shown escaped (JSON),
 * so a value can't end the list and add Markdown of its own; a cut value says how long it really is.
 */
function valueMarkdown(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  // eslint-disable-next-line no-control-regex
  const text = typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(raw) ? JSON.stringify(raw) : raw;
  if (text.length <= MAX_VALUE_CHARS) return inlineCode(text);
  const length = [...raw].length.toLocaleString('en-US');
  return `${inlineCode(`${text.slice(0, MAX_VALUE_CHARS)}…`)} (${length} characters, shortened)`;
}

/**
 * What the user confirms: the description, the inputs Copilot chose, the commands the workflow runs and the agents
 * that change the workspace without asking.
 */
export function confirmationMarkdown(prepared: PreparedCopilotRun): string {
  const sections: string[] = [];
  const { description } = prepared.workflow;
  if (typeof description === 'string' && description.trim() !== '') sections.push(plainText(description));
  const inputs = Object.entries(prepared.inputs);
  if (inputs.length > 0) {
    sections.push(
      ['**Inputs**', ...inputs.map(([name, value]) => `- ${inlineCode(name)}: ${valueMarkdown(value)}`)].join(
        '\n',
      ),
    );
  }
  const commands = consoleCommandsOf(prepared.workflow);
  const agents = prepared.unattendedAgents;
  if (commands.length > 0) sections.push(`**Commands it runs**\n\n${codeBlock(commands.join('\n'))}`);
  if (inputs.length > 0 && commandsUseInputs(prepared.workflow)) sections.push(INPUTS_IN_COMMANDS);
  if (agents.length > 0) {
    sections.push(
      ['**Agents that act without asking**', ...agents.map((line) => `- ${plainText(line)}`)].join('\n'),
    );
  }
  if (commands.length === 0 && agents.length === 0) sections.push('It runs no console commands.');
  return sections.join('\n\n');
}

/** `isarflow_listWorkflows`: the workflows Copilot may run. */
export function createListWorkflowsTool(
  services: Pick<CopilotServices, 'workflows'>,
  deps: CopilotDeps,
): vscode.LanguageModelTool<Record<string, never>> {
  return {
    async invoke() {
      const workflows = await loadCopilotWorkflows(services.workflows.list(), (uri) => deps.readText(uri));
      return textResult(workflowListMarkdown(workflows));
    },
  };
}

/** `isarflow_runWorkflow`: runs an exposed workflow after the user confirmed it, and returns its summary. */
export function createRunWorkflowTool(
  services: CopilotServices,
  deps: CopilotDeps,
): vscode.LanguageModelTool<RunWorkflowInput> {
  return {
    async prepareInvocation(options) {
      const query = typeof options.input?.workflow === 'string' ? options.input.workflow.trim() : '';
      let prepared: PreparedCopilotRun;
      try {
        prepared = await prepareCopilotRun(services, deps, query, options.input?.inputs);
      } catch {
        // invoke() explains the problem and never runs anything for such a request.
        return { invocationMessage: `Running ${query || 'a workflow'}…` };
      }
      return {
        invocationMessage: `Running ${prepared.name}…`,
        confirmationMessages: {
          title: `Run ${prepared.name}?`,
          message: new vscode.MarkdownString(confirmationMarkdown(prepared)),
        },
      };
    },

    async invoke(options, token) {
      const query = options.input?.workflow;
      if (typeof query !== 'string' || query.trim() === '') throw new Error(NO_WORKFLOW);
      const prepared = await prepareCopilotRun(services, deps, query, options.input.inputs);
      const result = await runForCopilot(services, deps, prepared, token);
      return textResult(result.text);
    },
  };
}
