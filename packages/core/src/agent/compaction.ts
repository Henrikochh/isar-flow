import type { StepIO, Usage } from '../engine/types';
import type { ChatMessage, ChatModel, ToolSpec } from '../models/types';
import { abortError, throwIfAborted } from './abort';
import { type Conversation, logOnce } from './conversation';
import { errorMessage, formatNumber, formatTokens, withoutPeriod } from './format';

/** Context size for models that report none and runs without the `isarFlow.agentContextTokens` setting. */
export const DEFAULT_CONTEXT_TOKENS = 24_000;
/** Share of the context above which the conversation is compacted. */
const COMPACT_ABOVE = 0.7;
const SUMMARY_MAX_TOKENS = 1024;
/** Each message of the summarized part is clipped to this many characters in the summary request. */
const CLIP_CHARS = 2000;
/** The rendered part to summarize may use this share of the context, at least MIN_RENDER_CHARS. */
const RENDER_SHARE = 0.8;
const MIN_RENDER_CHARS = 8000;
const SUMMARY_PREFIX = 'Summary of the earlier work (older messages were removed to save context):\n';
const REASONING = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
const WARNED = 'context-warning';

export interface TokenEstimateInput {
  system?: string;
  messages: readonly ChatMessage[];
  /** Native tool specs sent with the request. */
  tools?: readonly ToolSpec[];
}

/** Rough token count: a quarter token per character of system prompt, messages, call arguments and tool specs. */
export function estimateTokens({ system, messages, tools }: TokenEstimateInput): number {
  let chars = system?.length ?? 0;
  for (const message of messages) {
    chars += message.content.length;
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) chars += call.arguments.length;
    }
  }
  if (tools && tools.length > 0) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / 4);
}

export interface CompactionInput {
  model: ChatModel;
  conversation: Conversation;
  /** System prompt as sent, including the tool section of text tool mode. */
  system?: string;
  tools?: readonly ToolSpec[];
  /** Context size when the model reports none (setting `isarFlow.agentContextTokens`). */
  contextTokens?: number;
  io: StepIO;
}

interface Plan {
  task: ChatMessage;
  /** Messages replaced by the summary, oldest first. */
  middle: ChatMessage[];
  /** The latest tool exchange (and a pending corrective or repair request), kept verbatim. */
  tail: ChatMessage[];
  /** Only history before the task is summarized, so the summary goes before the task. */
  summaryFirst: boolean;
}

/**
 * Before a model turn: when the conversation is estimated above 70 % of the context, replaces the messages between
 * the task and the latest tool exchange with a summary written by the same model. Logs what happened; a failed
 * summary is logged and the full conversation is kept. Cancels are rethrown.
 */
export async function compactIfNeeded(input: CompactionInput): Promise<void> {
  const { conversation } = input;
  if (conversation.compactionFailed.has(input.model.ref)) return;
  const context = contextSize(input.model, input.contextTokens);
  const threshold = context.tokens * COMPACT_ABOVE;
  const estimate = () =>
    estimateTokens({ system: input.system, messages: conversation.messages, tools: input.tools });
  if (estimate() <= threshold) return;

  const plan = planCompaction(conversation.messages, conversation.taskIndex);
  if (plan) {
    if (!(await compact(input, plan, context.tokens))) return;
    if (estimate() <= threshold) return;
  }

  const parts = [
    `The conversation still needs about ${formatTokens(estimate())} tokens, more than 70 % of the ` +
      `${formatNumber(context.tokens)}-token context.`,
    'The system prompt, the task and the latest tool results are always kept in full.',
    'Attach fewer or smaller context files, or use a model with a larger context.',
  ];
  if (!context.fromModel) parts.push('If the model supports more, raise isarFlow.agentContextTokens.');
  logOnce(conversation, input.io, parts.join(' '), WARNED);
}

function contextSize(
  model: ChatModel,
  contextTokens: number | undefined,
): { tokens: number; fromModel: boolean } {
  if (isPositive(model.maxInputTokens)) return { tokens: model.maxInputTokens, fromModel: true };
  return { tokens: isPositive(contextTokens) ? contextTokens : DEFAULT_CONTEXT_TOKENS, fromModel: false };
}

function isPositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** What to keep and what to summarize; undefined when fewer than two messages could be summarized. */
function planCompaction(messages: ChatMessage[], taskIndex: number): Plan | undefined {
  const task = messages[taskIndex];
  if (!task || task.role !== 'user') return undefined;

  let tailStart = messages.length;
  const lastCalls = messages.findLastIndex((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
  if (lastCalls > taskIndex) tailStart = lastCalls;
  const last = messages.length - 1;
  if (last > taskIndex && messages[last].role === 'user') {
    // A corrective or JSON repair request stays together with the reply it is about.
    const reply = last - 1 > taskIndex && messages[last - 1].role === 'assistant' ? last - 1 : last;
    tailStart = Math.min(tailStart, reply);
  }

  const before = messages.slice(0, taskIndex);
  const after = messages.slice(taskIndex + 1, tailStart);
  if (before.length + after.length < 2) return undefined;
  return {
    task,
    middle: [...before, ...after],
    tail: messages.slice(tailStart),
    summaryFirst: after.length === 0,
  };
}

async function compact(input: CompactionInput, plan: Plan, contextTokens: number): Promise<boolean> {
  const { conversation, io } = input;
  let summary: string;
  try {
    summary = await summarize(input.model, plan, contextTokens, conversation.usage, io);
  } catch (error) {
    if (io.signal.aborted) throw abortError(io.signal);
    conversation.compactionFailed.add(input.model.ref);
    io.log(
      'info',
      `Could not compact the conversation: ${withoutPeriod(errorMessage(error))}. ` +
        'Continuing with the full conversation.\n',
    );
    return false;
  }

  const message: ChatMessage = { role: 'user', content: `${SUMMARY_PREFIX}${summary}` };
  conversation.messages = plan.summaryFirst
    ? [message, plan.task, ...plan.tail]
    : [plan.task, message, ...plan.tail];
  conversation.taskIndex = plan.summaryFirst ? 1 : 0;
  const removed = formatTokens(estimateTokens({ messages: plan.middle }));
  const added = formatTokens(Math.ceil(summary.length / 4));
  io.log(
    'info',
    `Compacted the conversation: ${plan.middle.length} older messages (about ${removed} tokens) ` +
      `replaced by a summary (about ${added} tokens).\n`,
  );
  return true;
}

/** Asks the model for the summary; its usage counts toward the block even when the request fails later. */
async function summarize(
  model: ChatModel,
  plan: Plan,
  contextTokens: number,
  usage: Usage,
  io: StepIO,
): Promise<string> {
  const prompt = summaryPrompt(plan, contextTokens);
  const options = { temperature: 0, maxTokens: SUMMARY_MAX_TOKENS, signal: io.signal };
  let text = '';
  for await (const event of model.chat([{ role: 'user', content: prompt }], options)) {
    if (event.type === 'text') text += event.text;
    else if (event.type === 'usage') {
      usage.inputTokens += event.inputTokens;
      usage.outputTokens += event.outputTokens;
    }
    throwIfAborted(io.signal);
  }
  const summary = text.replace(REASONING, '').trim();
  if (summary === '') throw new Error('the model returned an empty summary');
  return summary;
}

function summaryPrompt(plan: Plan, contextTokens: number): string {
  const instruction =
    'Summarize the earlier part of the conversation below so that the agent can continue its task with less ' +
    'context. Keep file paths, decisions, findings, errors and open work. Use at most 300 words. ' +
    'Write only the summary.';
  const task = clip(plan.task.content);
  const budget = Math.max(
    MIN_RENDER_CHARS,
    Math.floor((contextTokens - SUMMARY_MAX_TOKENS) * 4 * RENDER_SHARE) - instruction.length - task.length,
  );
  const entries = fitNewest(plan.middle.map(renderMessage), budget);
  return `${instruction}\n\nThe task of the agent:\n${task}\n\nThe earlier conversation:\n\n${entries.join('\n\n')}`;
}

function renderMessage(message: ChatMessage): string {
  switch (message.role) {
    case 'tool': {
      const label = message.isError ? 'Error from' : 'Result of';
      return `${label} ${message.name} (${message.toolCallId}):\n${clip(message.content)}`;
    }
    case 'assistant': {
      const lines = message.content.trim() === '' ? [] : [`Assistant:\n${clip(message.content)}`];
      for (const call of message.toolCalls ?? [])
        lines.push(`Tool call: ${call.name} ${clip(call.arguments)}`);
      return lines.join('\n');
    }
    default:
      return `User:\n${clip(message.content)}`;
  }
}

function clip(text: string): string {
  if (text.length <= CLIP_CHARS) return text;
  return `${text.slice(0, CLIP_CHARS)}\n… (${formatNumber(text.length - CLIP_CHARS)} more characters)`;
}

/** The newest entries that fit into `budget` characters; dropped older ones are mentioned. */
function fitNewest(entries: string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    used += entries[i].length + 2;
    if (used > budget && kept.length > 0) {
      return ['(Older messages are left out.)', ...kept];
    }
    kept.unshift(entries[i]);
  }
  return kept;
}
