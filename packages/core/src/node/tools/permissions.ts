import { type AgentPermissions, type StepIO, TOOL_INFO, type ToolName } from '../../index';
import type { PermissionPrompt } from '../types';
import { raceAbort } from './abort';
import { ToolError } from './toolContext';

const TURNED_OFF = {
  edits: 'Editing files is turned off for this agent (permissions.edits is "none").',
  commands: 'Running commands is turned off for this agent (permissions.commands is "none").',
};

/**
 * Applies an agent's permission levels: read tools always run, edit tools follow `permissions.edits`,
 * runCommand follows `permissions.commands`. 'ask' (also the default) asks the user; "Allow for this run"
 * is remembered per tool for the lifetime of this gate, which belongs to one run.
 */
export class PermissionGate {
  private readonly allowedForRun = new Set<ToolName>();

  constructor(
    private readonly runId: string,
    private readonly prompt: PermissionPrompt,
  ) {}

  async authorize(
    tool: ToolName,
    permissions: AgentPermissions,
    io: StepIO,
    summary: string,
    detail?: string,
  ): Promise<void> {
    const risk = TOOL_INFO[tool].risk;
    if (risk === 'read') return;
    const setting = risk === 'edit' ? 'edits' : 'commands';
    const level = permissions[setting] ?? 'ask';
    if (level === 'auto') return;
    if (level === 'none') {
      throw new ToolError(
        `${TURNED_OFF[setting]} Change permissions.${setting} to "ask" or "auto" in the agent to allow it.`,
      );
    }
    if (this.allowedForRun.has(tool)) return;
    const request = {
      runId: this.runId,
      stepId: io.stepId,
      tool,
      summary,
      ...(detail !== undefined && { detail }),
    };
    const answer = await raceAbort(this.prompt(request), io.signal);
    if (answer === 'allowRun') this.allowedForRun.add(tool);
    if (answer !== 'allow' && answer !== 'allowRun') {
      throw new ToolError(
        `The user declined this request (${summary}). Continue without it, or explain what you need.`,
      );
    }
  }
}
