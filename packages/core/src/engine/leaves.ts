import type { ExpressionContext } from '../expr';
import type { ChatMessage } from '../models/types';
import type { AgentDefinition, AgentStep, ApprovalStep, ConsoleStep, ShellName } from '../schema/types';
import { resolveAgent } from './agents';
import { renderEnv, renderField } from './context';
import type { BlockResult } from './result';
import { stepTimeoutMs } from './timing';
import type { AgentResult, ApprovalResult, ConsoleResult, EngineHost, StepIO, Usage } from './types';

/** Result of a host call, plus what the engine applies only when the call was not cut short. */
export interface LeafOutcome extends BlockResult {
  usage?: Usage;
  commit?: () => void;
}

/** A host-backed block with its templates rendered, ready to run (and re-run on retry). */
export interface PreparedLeaf {
  detail?: string;
  /** Must not throw synchronously; failures arrive as rejections. */
  invoke(io: StepIO): Promise<LeafOutcome>;
}

export interface LeafDeps {
  host: EngineHost;
  ctx: ExpressionContext;
  /** Rendered workflow-level env (without the process env). */
  workflowEnv: Record<string, string>;
  defaultShell?: ShellName;
  workspaceRoot: string;
  agents: Record<string, AgentDefinition>;
  /** Conversation per block id for `session: continue`. */
  sessions: Map<string, ChatMessage[]>;
}

export function timeoutMessage(seconds: number | undefined): string {
  return seconds === undefined ? 'Timed out' : `Timed out after ${seconds}s`;
}

export function prepareConsole(step: ConsoleStep, deps: LeafDeps): PreparedLeaf {
  const command = renderField('run', step.run, deps.ctx);
  const cwd = step.cwd === undefined ? deps.workspaceRoot : renderField('cwd', step.cwd, deps.ctx);
  const env = { ...deps.workflowEnv, ...renderEnv('env', step.env, deps.ctx) };
  const shell = step.shell ?? deps.defaultShell ?? 'auto';
  const timeoutMs = stepTimeoutMs(step.timeout);
  return {
    detail: command,
    invoke: async (io) => {
      const request = {
        stepId: step.id,
        command,
        shell,
        cwd,
        env,
        ...(timeoutMs !== undefined && { timeoutMs }),
      };
      return consoleOutcome(step, await deps.host.runConsole(request, io));
    },
  };
}

function consoleOutcome(step: ConsoleStep, result: ConsoleResult): LeafOutcome {
  const output = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.output,
    timedOut: result.timedOut,
  };
  if (result.timedOut) return { status: 'failure', output, error: timeoutMessage(step.timeout) };
  if (result.exitCode !== 0) {
    return { status: 'failure', output, error: `Command exited with code ${result.exitCode}` };
  }
  return { status: 'success', output };
}

export function prepareAgent(step: AgentStep, deps: LeafDeps): PreparedLeaf {
  const { agentId, agent } = resolveAgent(step, deps.agents);
  const prompt = renderField('prompt', step.prompt, deps.ctx);
  const contextFiles = (step.context?.files ?? []).map((glob, i) =>
    renderField(`context.files[${i}]`, glob, deps.ctx),
  );
  return {
    detail: prompt,
    invoke: async (io) => {
      const history = step.session === 'continue' ? (deps.sessions.get(step.id) ?? []) : [];
      const request = {
        stepId: step.id,
        ...(agentId !== undefined && { agentId }),
        agent,
        prompt,
        ...(step.output !== undefined && { output: step.output }),
        history,
        contextFiles,
      };
      return agentOutcome(step, await deps.host.runAgent(request, io), deps.sessions);
    },
  };
}

function agentOutcome(
  step: AgentStep,
  result: AgentResult,
  sessions: Map<string, ChatMessage[]>,
): LeafOutcome {
  const usage = {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
  return {
    status: 'success',
    output: {
      text: result.text,
      json: result.json,
      model: result.model,
      usage,
      turns: result.turns,
      toolCalls: result.toolCalls ?? 0,
    },
    usage,
    commit: () => sessions.set(step.id, result.messages ?? []),
  };
}

export function prepareApproval(step: ApprovalStep, deps: LeafDeps): PreparedLeaf {
  const message = renderField('message', step.message, deps.ctx);
  return {
    detail: message,
    invoke: async (io) =>
      approvalOutcome(step, await deps.host.requestApproval({ stepId: step.id, message }, io)),
  };
}

function approvalOutcome(step: ApprovalStep, result: ApprovalResult): LeafOutcome {
  const output = { approved: result.approved, comment: result.comment ?? '' };
  if (result.approved || step.onReject === 'continue') return { status: 'success', output };
  const error = `Rejected at '${step.id}'${result.comment ? `: ${result.comment}` : ''}`;
  return { status: 'failure', output, error, control: { kind: 'stop', outcome: 'failure', error } };
}
