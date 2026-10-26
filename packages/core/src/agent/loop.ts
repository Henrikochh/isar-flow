import type { StepIO, Usage } from '../engine/types';
import type { ChatMessage, ChatModel, ChatOptions, ToolCall } from '../models/types';
import type { OutputShape } from '../schema/types';
import { abortError, throwIfAborted } from './abort';
import {
  checkJsonShape,
  describeOutputShape,
  extractJson,
  extractJsonMatching,
  isJsonSchema,
  shapeToJsonSchema,
  validateOutputShape,
} from './json';
import { BUILTIN_TOOLS, describeToolCall, isToolName, summarizeToolResult, toolSpecsFor } from './tools';
import type { AgentLoopOptions, AgentLoopResult, ToolResult } from './types';

const DEFAULT_MAX_TURNS = 20;

/** Progress of one agent conversation. Kept outside the loop so a fallback model can pick it up. */
export interface Conversation {
  /** Messages without the system prompt. */
  messages: ChatMessage[];
  usage: Usage;
  /** Completed model round-trips. */
  turns: number;
  repairRequested: boolean;
}

/** Builds the opening conversation: history (minus system messages) and the prompt, plus JSON instructions. */
export function startConversation(
  options: Pick<AgentLoopOptions, 'history' | 'prompt' | 'output'>,
): Conversation {
  const json = options.output?.format === 'json';
  const shape = json ? options.output?.schema : undefined;
  if (shape) {
    const problems = validateOutputShape(shape);
    if (problems.length > 0) {
      throw new Error(
        `The output schema is invalid: ${problems.join(' ')} Fix output.schema of the agent block.`,
      );
    }
  }
  const history = (options.history ?? []).filter((message) => message.role !== 'system');
  const prompt = json ? `${options.prompt}\n\n${jsonInstruction(shape)}` : options.prompt;
  return {
    messages: [...history, { role: 'user', content: prompt }],
    usage: { inputTokens: 0, outputTokens: 0 },
    turns: 0,
    repairRequested: false,
  };
}

/** Runs the tool-calling loop until the model gives a final answer. */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  return continueConversation(options, startConversation(options));
}

/** Runs model turns on `conversation`, updating it in place, until the model gives a final answer. */
export async function continueConversation(
  options: AgentLoopOptions,
  conversation: Conversation,
): Promise<AgentLoopResult> {
  const { model, io } = options;
  const maxTurns = Math.max(1, options.maxTurns ?? DEFAULT_MAX_TURNS);
  const json = options.output?.format === 'json';
  const shape = json ? options.output?.schema : undefined;
  const toolSpecs = toolSpecsFor(options.tools);
  const chatOptions: ChatOptions = {
    tools: toolSpecs.length > 0 ? toolSpecs : undefined,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    jsonSchema:
      shape && model.capabilities.jsonSchema
        ? { name: 'answer', schema: shapeToJsonSchema(shape) }
        : undefined,
    signal: io.signal,
  };
  const system: ChatMessage[] = options.systemPrompt
    ? [{ role: 'system', content: options.systemPrompt }]
    : [];

  for (;;) {
    throwIfAborted(io.signal);
    const reply = await streamTurn(
      model,
      [...system, ...conversation.messages],
      chatOptions,
      io,
      conversation,
    );
    conversation.turns++;

    if (reply.toolCalls.length > 0) {
      // The single JSON repair round does not count against maxTurns.
      if (conversation.turns >= maxTurns + (conversation.repairRequested ? 1 : 0)) {
        throw new Error(
          `The agent used all ${maxTurns} turns without giving a final answer. Increase maxTurns or simplify the task.`,
        );
      }
      conversation.messages.push({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls });
      for (const call of reply.toolCalls) {
        throwIfAborted(io.signal);
        const result = await runToolCall(call, options);
        conversation.messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
      }
      continue;
    }

    conversation.messages.push({ role: 'assistant', content: reply.text });
    const result: AgentLoopResult = {
      text: reply.text,
      usage: { ...conversation.usage },
      turns: conversation.turns,
      messages: [...conversation.messages],
      model: model.ref,
    };
    if (!json) return result;

    const answer = parseAnswer(reply.text, shape);
    if (answer.problems.length === 0) return { ...result, json: answer.value };
    if (conversation.repairRequested) {
      throw new Error(
        `The agent's answer is not valid JSON for the expected shape: ${sentence(answer.problems.join('; '))} ` +
          'Describe the expected JSON more clearly in the prompt, or relax output.schema.',
      );
    }
    conversation.repairRequested = true;
    io.log('info', 'The answer is not valid JSON for the expected shape; asking the agent to correct it.\n');
    conversation.messages.push({ role: 'user', content: repairPrompt(answer.problems, shape) });
  }
}

async function streamTurn(
  model: ChatModel,
  messages: ChatMessage[],
  chatOptions: ChatOptions,
  io: StepIO,
  conversation: Conversation,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  let finishReason: string | undefined;
  try {
    for await (const event of model.chat(messages, chatOptions)) {
      switch (event.type) {
        case 'text':
          if (event.text) {
            text += event.text;
            io.log('agent', event.text);
          }
          break;
        case 'tool-call':
          toolCalls.push(event.call);
          break;
        case 'usage':
          conversation.usage.inputTokens += event.inputTokens;
          conversation.usage.outputTokens += event.outputTokens;
          break;
        case 'done':
          finishReason = event.finishReason;
          break;
      }
      throwIfAborted(io.signal);
    }
  } catch (error) {
    if (io.signal.aborted) throw abortError(io.signal);
    throw error;
  }
  if (finishReason === 'length' && toolCalls.length === 0) {
    io.log(
      'info',
      'The model stopped at its maxTokens limit, so the answer may be cut off. Raise maxTokens if needed.\n',
    );
  }
  // Tool results must reference their call, so calls without an id get one that is unique in this conversation.
  const base = conversation.messages.length;
  return {
    text,
    toolCalls: toolCalls.map((call, index) =>
      call.id ? call : { ...call, id: `call_${base}_${index + 1}` },
    ),
  };
}

async function runToolCall(call: ToolCall, options: AgentLoopOptions): Promise<ToolResult> {
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

function parseAnswer(text: string, shape: OutputShape | undefined): { value?: unknown; problems: string[] } {
  try {
    return shape ? extractJsonMatching(text, shape) : { value: extractJson(text), problems: [] };
  } catch (error) {
    return { problems: [errorMessage(error)] };
  }
}

function shapeText(shape: OutputShape): string {
  const intro = isJsonSchema(shape)
    ? 'It must match this JSON Schema:'
    : 'It must match this shape (keys marked with ? are optional):';
  return `${intro}\n${describeOutputShape(shape)}`;
}

function jsonInstruction(shape: OutputShape | undefined): string {
  const base = 'Your final answer must be JSON only, with no explanations and no code fences.';
  return shape ? `${base} ${shapeText(shape)}` : base;
}

function repairPrompt(problems: string[], shape: OutputShape | undefined): string {
  const lines = [
    'Your answer is not valid JSON for the expected shape:',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Reply again with the corrected JSON only, with no explanations and no code fences.',
  ];
  if (shape) lines.push(shapeText(shape));
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sentence(text: string): string {
  return `${text.replace(/[.\s]+$/, '')}.`;
}
