import { AgentRunError } from '../engine/errors';
import type { StepIO, Usage } from '../engine/types';
import type { ChatMessage, ChatModel, ChatOptions, ToolCall } from '../models/types';
import type { ToolMode } from '../schema/types';
import { abortError, throwIfAborted } from './abort';
import { compactIfNeeded } from './compaction';
import { type Conversation, logOnce, startConversation } from './conversation';
import { errorMessage, sentence } from './format';
import { shapeToJsonSchema } from './json';
import { parseAnswer, repairPrompt } from './jsonAnswer';
import { correctivePrompt, toTextModeMessages, withToolSection } from './textTools';
import { parseTextToolCalls, type TextToolCall } from './toolCallText';
import { runToolCall } from './toolRun';
import { isToolName, toolSpecsFor } from './tools';
import type { AgentLoopOptions, AgentLoopResult } from './types';

export { type Conversation, startConversation } from './conversation';

const DEFAULT_MAX_TURNS = 20;
const REPAIRED_CALL = 'The model wrote a tool call as text; running it.';
const UNREADABLE_CALL = 'The model wrote a tool call that could not be read; asking it to correct it.';
const UNREADABLE_TWICE =
  'The model wrote tool calls that could not be read twice. In the agent, set Tool calls to Text in the prompt, ' +
  'or use a model with native tool calling.';

/**
 * How tools reach the model. `native`: tool specs in the request. `text`: described in the system prompt, calls
 * written as `<tool_call>` text. `repair`: calls written as text in the reply are run too.
 */
interface ToolChannel {
  native: boolean;
  text: boolean;
  repair: boolean;
}

/**
 * Runs the tool-calling loop until the model gives a final answer. When the run fails after the model used
 * tokens, the error is an {@link AgentRunError} that carries the usage.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const conversation = startConversation(options);
  try {
    return await continueConversation(options, conversation);
  } catch (error) {
    throw withUsage(error, conversation.usage, conversation.toolCalls);
  }
}

/**
 * The error to throw for a failed run: wrapped in an AgentRunError when tokens were used, so they (and the tool
 * calls made so far) still count.
 */
export function withUsage(error: unknown, usage: Usage, toolCalls = 0): unknown {
  if (usage.inputTokens + usage.outputTokens <= 0) return error;
  return new AgentRunError(
    errorMessage(error),
    { ...usage },
    { cause: error, ...(toolCalls > 0 && { toolCalls }) },
  );
}

/**
 * Runs model turns on `conversation`, updating it in place, until the model gives a final answer.
 * Errors are not wrapped: the caller decides about fallbacks and adds `conversation.usage` with withUsage.
 */
export async function continueConversation(
  options: AgentLoopOptions,
  conversation: Conversation,
): Promise<AgentLoopResult> {
  const { model, io } = options;
  const maxTurns = Math.max(1, options.maxTurns ?? DEFAULT_MAX_TURNS);
  const json = options.output?.format === 'json';
  const shape = json ? options.output?.schema : undefined;
  const enabled = [...new Set(options.tools.filter(isToolName))];
  const channel = toolChannel(options.toolMode, model, enabled.length > 0);
  if (channel.text && options.toolMode !== 'text') {
    logOnce(
      conversation,
      io,
      `${model.ref} has no native tool calling, so the tools are described in the prompt (text tool mode).`,
    );
  }
  const specs = channel.native ? toolSpecsFor(enabled) : [];
  const systemPrompt = channel.text
    ? withToolSection(options.systemPrompt, toolSpecsFor(enabled))
    : options.systemPrompt;
  const chatOptions: ChatOptions = {
    tools: specs.length > 0 ? specs : undefined,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    // A schema-constrained answer could not contain the <tool_call> text that text mode needs.
    jsonSchema:
      shape && model.capabilities.jsonSchema && !channel.text
        ? { name: 'answer', schema: shapeToJsonSchema(shape) }
        : undefined,
    signal: io.signal,
  };
  const system: ChatMessage[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];

  for (;;) {
    throwIfAborted(io.signal);
    await compactIfNeeded({
      model,
      conversation,
      system: systemPrompt,
      tools: specs,
      contextTokens: options.contextTokens,
      io,
    });
    const sent = channel.text ? toTextModeMessages(conversation.messages) : conversation.messages;
    const reply = await streamTurn(model, [...system, ...sent], chatOptions, io, conversation);
    conversation.turns++;

    let { text, toolCalls } = reply;
    if (toolCalls.length === 0 && channel.repair) {
      const found = parseTextToolCalls(reply.text, enabled, { jsonAnswer: json });
      if (found.malformed) {
        if (conversation.unreadableReplies > 0) throw new Error(UNREADABLE_TWICE);
        conversation.unreadableReplies++;
        conversation.correctiveRounds++;
        io.log('info', `${UNREADABLE_CALL}\n`);
        conversation.messages.push(
          { role: 'assistant', content: reply.text },
          { role: 'user', content: correctivePrompt(found.malformed.name, found.malformed.problem) },
        );
        continue;
      }
      if (found.calls.length > 0) {
        if (channel.native) logOnce(conversation, io, REPAIRED_CALL);
        toolCalls = withCallIds(found.calls, conversation.messages);
        text = found.text;
      }
    }
    conversation.unreadableReplies = 0;

    if (toolCalls.length > 0) {
      // The JSON repair round and corrective rounds do not count against maxTurns.
      const freeTurns = (conversation.repairRequested ? 1 : 0) + conversation.correctiveRounds;
      if (conversation.turns >= maxTurns + freeTurns) {
        throw new Error(
          `The agent used all ${maxTurns} turns without giving a final answer. Increase maxTurns or simplify the task.`,
        );
      }
      conversation.messages.push({ role: 'assistant', content: text, toolCalls });
      for (const call of toolCalls) {
        throwIfAborted(io.signal);
        const result = await runToolCall(call, options);
        conversation.toolCalls++;
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
      toolCalls: conversation.toolCalls,
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

/** Native specs plus repair for models with tool calling; text mode for the others (or when chosen). */
function toolChannel(mode: ToolMode | undefined, model: ChatModel, hasTools: boolean): ToolChannel {
  if (!hasTools) return { native: false, text: false, repair: false };
  if (mode === 'native') return { native: true, text: false, repair: false };
  if (mode === 'text' || !model.capabilities.tools) return { native: false, text: true, repair: true };
  return { native: true, text: false, repair: true };
}

/** Calls found in text get ids `call_<n>` that are unique in the conversation. */
function withCallIds(calls: TextToolCall[], messages: ChatMessage[]): ToolCall[] {
  const used = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) used.add(call.id);
  }
  let n = used.size;
  return calls.map((call) => {
    let id = `call_${++n}`;
    while (used.has(id)) id = `call_${++n}`;
    used.add(id);
    return { id, name: call.name, arguments: JSON.stringify(call.args) };
  });
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
