import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { walkSteps, type Workflow } from '@isar-flow/core';

const MEMENTO_KEY = 'isarFlow.approvedCommands';
/** Hashes kept per workflow, so switching between a few versions of a file does not ask every time. */
const MAX_HASHES_PER_WORKFLOW = 20;
const MAX_LISTED_COMMANDS = 15;

export const RUN_BUTTON = 'Run';
export const RUN_AND_REMEMBER_BUTTON = 'Run and remember';

/** The raw `run` strings of all console blocks, nested ones included, in document order. */
export function consoleCommandsOf(workflow: Workflow): string[] {
  const commands: string[] = [];
  walkSteps(workflow.steps ?? [], ({ step }) => {
    if (step.type === 'console' && typeof step.run === 'string') commands.push(step.run);
  });
  return commands;
}

/** sha256 (hex) of the command list; line endings are normalized so a checkout on another OS hashes the same. */
export function hashCommands(commands: string[]): string {
  const normalized = commands.map((command) => command.replace(/\r\n?/g, '\n'));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Approved command hashes per workflow URI, kept in workspace state. */
export class CommandApprovals {
  constructor(private readonly memento: vscode.Memento) {}

  isApproved(workflowUri: string, hash: string): boolean {
    return this.read()[workflowUri]?.includes(hash) ?? false;
  }

  async approve(workflowUri: string, hash: string): Promise<void> {
    const all = this.read();
    const hashes = (all[workflowUri] ?? []).filter((h) => h !== hash);
    hashes.push(hash);
    all[workflowUri] = hashes.slice(-MAX_HASHES_PER_WORKFLOW);
    await this.memento.update(MEMENTO_KEY, all);
  }

  private read(): Record<string, string[]> {
    return { ...this.memento.get<Record<string, string[]>>(MEMENTO_KEY, {}) };
  }
}

export interface CommandConfirmation {
  workflowUri: string;
  workflowName: string;
  /** Raw commands (see consoleCommandsOf). */
  commands: string[];
  approvals: CommandApprovals;
  /** The `isarFlow.confirmCommands` setting. */
  enabled: boolean;
  /** Modal question; resolves to the chosen button, or undefined when dismissed. */
  ask?: (message: string, detail: string, buttons: string[]) => Promise<string | undefined>;
}

const askModal = async (message: string, detail: string, buttons: string[]) =>
  vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons);

function commandList(commands: string[]): string {
  const unique = [...new Set(commands.map((c) => c.replace(/\r\n?/g, '\n').trim()))];
  const listed = unique.slice(0, MAX_LISTED_COMMANDS).map((c) => `• ${c.split('\n').join('\n   ')}`);
  if (unique.length > MAX_LISTED_COMMANDS) listed.push(`and ${unique.length - MAX_LISTED_COMMANDS} more`);
  return listed.join('\n');
}

/**
 * Asks before running console commands whose hash has not been approved for this workflow.
 * Resolves true when the run may go ahead.
 */
export async function confirmCommands(options: CommandConfirmation): Promise<boolean> {
  const { workflowUri, commands, approvals } = options;
  if (!options.enabled || commands.length === 0) return true;
  const hash = hashCommands(commands);
  if (approvals.isApproved(workflowUri, hash)) return true;

  const message = `Run '${options.workflowName}'? It runs these commands in your workspace:`;
  const detail = `${commandList(commands)}\n\n"${RUN_AND_REMEMBER_BUTTON}" skips this question until the commands change.`;
  const choice = await (options.ask ?? askModal)(message, detail, [RUN_BUTTON, RUN_AND_REMEMBER_BUTTON]);
  if (choice === RUN_AND_REMEMBER_BUTTON) {
    await approvals.approve(workflowUri, hash);
    return true;
  }
  return choice === RUN_BUTTON;
}
