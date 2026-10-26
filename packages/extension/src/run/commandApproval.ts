import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  isToolName,
  TOOL_INFO,
  walkSteps,
  type AgentDefinition,
  type AgentSettings,
  type Workflow,
} from '@isar-flow/core';

const MEMENTO_KEY = 'isarFlow.approvedCommands';
/** Hashes kept per workflow, so switching between a few versions of a file does not ask every time. */
const MAX_HASHES_PER_WORKFLOW = 20;
const MAX_LISTED_COMMANDS = 15;

export const RUN_BUTTON = 'Run';
export const RUN_AND_REMEMBER_BUTTON = 'Run and remember';

/**
 * The commands of all console blocks, nested ones included, in document order: the raw `run` string, plus a
 * line with the shell, folder and environment when the block sets them, because they change what runs
 * (NODE_OPTIONS, PATH …). The workflow's own environment comes first. A remembered approval therefore no
 * longer applies once any of these change.
 */
export function consoleCommandsOf(workflow: Workflow): string[] {
  const commands: string[] = [];
  walkSteps(workflow.steps ?? [], ({ step }) => {
    if (step.type !== 'console' || typeof step.run !== 'string') return;
    const setup: string[] = [];
    if (step.shell) setup.push(`shell: ${step.shell}`);
    if (step.cwd) setup.push(`folder: ${step.cwd}`);
    const env = envText(step.env);
    if (env) setup.push(`environment: ${env}`);
    commands.push(setup.length > 0 ? `${step.run.replace(/\r?\n$/, '')}\n(${setup.join(', ')})` : step.run);
  });
  const shared = envText(workflow.env);
  if (shared && commands.length > 0) commands.unshift(`(environment of all commands: ${shared})`);
  return commands;
}

function envText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(', ');
}

/** What an agent does without asking: 'edits files', 'runs commands', both, or undefined when it always asks. */
function unattendedActions(settings: AgentSettings | undefined): string | undefined {
  const tools = (settings?.tools ?? []).filter(isToolName);
  const permissions = settings?.permissions ?? {};
  const edits = permissions.edits === 'auto' && tools.some((tool) => TOOL_INFO[tool].risk === 'edit');
  const commands =
    permissions.commands === 'auto' && tools.some((tool) => TOOL_INFO[tool].risk === 'command');
  if (edits && commands) return 'edits files and runs commands';
  if (edits) return 'edits files';
  if (commands) return 'runs commands';
  return undefined;
}

function blockList(ids: string[]): string {
  const quoted = ids.map((id) => `'${id}'`);
  if (quoted.length === 1) return `block ${quoted[0]}`;
  return `blocks ${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

/**
 * The agents of all agent blocks, nested ones included, that edit files or run commands without asking:
 * `permissions.edits: auto` with editFile or writeFile, or `permissions.commands: auto` with runCommand.
 * Agent files are looked up by id in `definitions` (unknown ids are skipped; validation reports them) and
 * listed once with every block that uses them; inline agents are listed per block. A block's model override
 * does not matter. One line per agent in document order, e.g.
 * "agent 'coder' in block 'implement': edits files and runs commands without asking". A remembered approval
 * therefore no longer applies once an agent's tools or permissions change.
 */
export function unattendedAgentsOf(
  workflow: Workflow,
  definitions: Record<string, AgentDefinition>,
): string[] {
  const found = new Map<string, { agent: string; actions: string; blocks: string[] }>();
  walkSteps(workflow.steps ?? [], ({ step }) => {
    if (step.type !== 'agent') return;
    const agentId = typeof step.agent === 'string' ? step.agent : undefined;
    let settings: AgentSettings | undefined = typeof step.agent === 'object' ? step.agent : undefined;
    if (agentId !== undefined && Object.hasOwn(definitions, agentId)) settings = definitions[agentId];
    const actions = unattendedActions(settings);
    if (!actions) return;
    const key = agentId === undefined ? `inline\n${step.id}` : `file\n${agentId}\n${actions}`;
    const entry = found.get(key);
    if (entry) entry.blocks.push(step.id);
    else {
      const agent = agentId === undefined ? 'inline agent' : `agent '${agentId}'`;
      found.set(key, { agent, actions, blocks: [step.id] });
    }
  });
  return [...found.values()].map(
    ({ agent, actions, blocks }) => `${agent} in ${blockList(blocks)}: ${actions} without asking`,
  );
}

/**
 * sha256 (hex) of the command list and the agents that act without asking (see unattendedAgentsOf); line
 * endings are normalized so a checkout on another OS hashes the same. Without such agents it is the hash of
 * the commands alone, so approvals remembered before agents were covered keep applying.
 */
export function hashCommands(commands: string[], agents: string[] = []): string {
  const normalize = (lines: string[]) => lines.map((line) => line.replace(/\r\n?/g, '\n'));
  const content =
    agents.length === 0 ? normalize(commands) : { commands: normalize(commands), agents: normalize(agents) };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
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
  /** Agents that edit files or run commands without asking (see unattendedAgentsOf). */
  agents?: string[];
  approvals: CommandApprovals;
  /** The `isarFlow.confirmCommands` setting. */
  enabled: boolean;
  /** Modal question; resolves to the chosen button, or undefined when dismissed. */
  ask?: (message: string, detail: string, buttons: string[]) => Promise<string | undefined>;
}

const askModal = async (message: string, detail: string, buttons: string[]) =>
  vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons);

function bulletList(lines: string[]): string {
  const unique = [...new Set(lines.map((c) => c.replace(/\r\n?/g, '\n').trim()))];
  const listed = unique.slice(0, MAX_LISTED_COMMANDS).map((c) => `• ${c.split('\n').join('\n   ')}`);
  if (unique.length > MAX_LISTED_COMMANDS) listed.push(`and ${unique.length - MAX_LISTED_COMMANDS} more`);
  return listed.join('\n');
}

function question(name: string, commands: string[], agents: string[]): { message: string; detail: string } {
  if (agents.length === 0) {
    return {
      message: `Run '${name}'? It runs these commands in your workspace:`,
      detail: `${bulletList(commands)}\n\n"${RUN_AND_REMEMBER_BUTTON}" skips this question until the commands change.`,
    };
  }
  const remember = `"${RUN_AND_REMEMBER_BUTTON}" skips this question until anything listed here changes.`;
  if (commands.length === 0) {
    return {
      message: `Run '${name}'? These agents can change your workspace without asking:`,
      detail: `${bulletList(agents)}\n\n${remember}`,
    };
  }
  return {
    message: `Run '${name}'? It runs these commands and lets agents change your workspace without asking:`,
    detail: `${bulletList(commands)}\n\nAgents that act without asking:\n${bulletList(agents)}\n\n${remember}`,
  };
}

/**
 * Asks before running console commands, or agents that act without asking, whose hash has not been approved
 * for this workflow. Resolves true when the run may go ahead.
 */
export async function confirmCommands(options: CommandConfirmation): Promise<boolean> {
  const { workflowUri, commands, approvals } = options;
  const agents = options.agents ?? [];
  if (!options.enabled || (commands.length === 0 && agents.length === 0)) return true;
  const hash = hashCommands(commands, agents);
  if (approvals.isApproved(workflowUri, hash)) return true;

  const { message, detail } = question(options.workflowName, commands, agents);
  const choice = await (options.ask ?? askModal)(message, detail, [RUN_BUTTON, RUN_AND_REMEMBER_BUTTON]);
  if (choice === RUN_AND_REMEMBER_BUTTON) {
    await approvals.approve(workflowUri, hash);
    return true;
  }
  return choice === RUN_BUTTON;
}
