import type { StepIO } from '../engine/types';
import type { ToolCall } from '../models/types';
import { abortError } from './abort';
import { errorMessage } from './format';
import { checkJsonShape } from './json';
import { REMEMBER_TOOL } from './memory';
import { agentToolSpec, describeToolCall, isAgentToolName, isToolName, summarizeToolResult } from './tools';
import type { AgentLoopOptions, AgentMemory, ToolResult } from './types';

type RememberFn = NonNullable<AgentMemory['remember']>;

/** Runs one tool call (or refuses it) and logs it; problems become error results for the model. */
export async function runToolCall(call: ToolCall, options: AgentLoopOptions): Promise<ToolResult> {
  const { io } = options;
  const parsed = parseArguments(call.arguments);
  const args = parsed.ok ? parsed.args : {};
  const problem =
    refusal(call.name, options) ?? (parsed.ok ? invalidArguments(call.name, args) : parsed.error);

  const save = options.memory?.remember;
  let result: ToolResult;
  if (problem) {
    result = { content: problem, isError: true };
  } else if (call.name === REMEMBER_TOOL.name && save) {
    result = await remember(save, String(args.note), io);
  } else if (!options.toolHost) {
    const content = `The tool "${call.name}" cannot run here because no tool host is available. Answer without tools.`;
    result = { content, isError: true };
  } else {
    try {
      result = await options.toolHost.execute({ name: call.name, args }, io, options.permissions);
    } catch (error) {
      if (io.signal.aborted) throw abortError(io.signal);
      result = { content: `The tool failed: ${errorMessage(error)}`, isError: true };
    }
  }
  const outcome = call.name === REMEMBER_TOOL.name && !result.isError ? 'saved' : summarizeToolResult(result);
  io.log('tool', `${describeToolCall(call.name, args)} → ${outcome}\n`);
  return result;
}

/** remember is answered here, never by the ToolHost; a rejection is an error result, not a failed block. */
async function remember(save: RememberFn, note: string, io: StepIO): Promise<ToolResult> {
  try {
    const line = await save(note, io);
    return { content: `Saved to the project memory: ${line}` };
  } catch (error) {
    if (io.signal.aborted) throw abortError(io.signal);
    return { content: errorMessage(error), isError: true };
  }
}

/** Tools this agent may call: its enabled built-in tools, then remember when it has memory write access. */
export function callableTools(options: Pick<AgentLoopOptions, 'tools' | 'memory'>): string[] {
  const enabled: string[] = [...new Set(options.tools.filter(isToolName))];
  if (options.memory?.remember) enabled.push(REMEMBER_TOOL.name);
  return enabled;
}

/** Why the agent may not call this tool (unknown or not enabled), or undefined. */
function refusal(name: string, options: AgentLoopOptions): string | undefined {
  const enabled = callableTools(options);
  const available =
    enabled.length > 0 ? `Available tools: ${enabled.join(', ')}.` : 'This agent has no tools.';
  if (!isAgentToolName(name) || (name === REMEMBER_TOOL.name && !enabled.includes(name))) {
    return `Unknown tool "${name}". ${available}`;
  }
  if (!enabled.includes(name)) return `The tool "${name}" is not enabled for this agent. ${available}`;
  return undefined;
}

function parseArguments(
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, args: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON arguments: ${errorMessage(error)}. Send the arguments as one JSON object.`,
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    return { ok: false, error: `Invalid JSON arguments: expected a JSON object, got ${kind}.` };
  }
  // Models often send null for optional parameters they do not use; treat that as "not given".
  const args = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
  return { ok: true, args };
}

function invalidArguments(name: string, args: Record<string, unknown>): string | undefined {
  if (!isAgentToolName(name)) return undefined;
  const problems = checkJsonShape(args, agentToolSpec(name).parameters);
  return problems.length > 0 ? `Invalid arguments for ${name}: ${problems.join('; ')}.` : undefined;
}
