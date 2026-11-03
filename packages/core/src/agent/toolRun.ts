import type { ToolCall } from '../models/types';
import { abortError } from './abort';
import { errorMessage } from './format';
import { checkJsonShape } from './json';
import { BUILTIN_TOOLS, describeToolCall, isToolName, summarizeToolResult } from './tools';
import type { AgentLoopOptions, ToolResult } from './types';

/** Runs one tool call (or refuses it) and logs it; problems become error results for the model. */
export async function runToolCall(call: ToolCall, options: AgentLoopOptions): Promise<ToolResult> {
  const { io } = options;
  const parsed = parseArguments(call.arguments);
  const args = parsed.ok ? parsed.args : {};
  const problem =
    refusal(call.name, options.tools) ?? (parsed.ok ? invalidArguments(call.name, args) : parsed.error);

  let result: ToolResult;
  if (problem) {
    result = { content: problem, isError: true };
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
  io.log('tool', `${describeToolCall(call.name, args)} → ${summarizeToolResult(result)}\n`);
  return result;
}

/** Why the agent may not call this tool (unknown or not enabled), or undefined. */
function refusal(name: string, tools: AgentLoopOptions['tools']): string | undefined {
  const enabled = tools.filter(isToolName);
  const available =
    enabled.length > 0 ? `Available tools: ${enabled.join(', ')}.` : 'This agent has no tools.';
  if (!isToolName(name)) return `Unknown tool "${name}". ${available}`;
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
  if (!isToolName(name)) return undefined;
  const problems = checkJsonShape(args, BUILTIN_TOOLS[name].parameters);
  return problems.length > 0 ? `Invalid arguments for ${name}: ${problems.join('; ')}.` : undefined;
}
