import type { StepIO, Usage } from '../engine/types';
import type { ChatMessage } from '../models/types';
import { validateOutputShape } from './json';
import { jsonInstruction } from './jsonAnswer';
import type { AgentLoopOptions } from './types';

/** Progress of one agent conversation. Kept outside the loop so a fallback model can pick it up. */
export interface Conversation {
  /** Messages without the system prompt, in canonical form (native tool calls and tool results). */
  messages: ChatMessage[];
  usage: Usage;
  /** Completed model round-trips. */
  turns: number;
  repairRequested: boolean;
  /** Tool calls executed by every model of the block, refused and failed ones included. */
  toolCalls: number;
  /** Index of the task (the prompt of this execution) in `messages`; compaction keeps it verbatim. */
  taskIndex: number;
  /** Replies in a row whose tool calls could not be read. */
  unreadableReplies: number;
  /** Rounds that asked for a corrected tool call; like the JSON repair round they do not count against maxTurns. */
  correctiveRounds: number;
  /** Keys of info lines already logged for this block, so each appears once. */
  notes: Set<string>;
  /** Models (refs) whose summary request failed in this block; they do not try to compact again. */
  compactionFailed: Set<string>;
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
    toolCalls: 0,
    taskIndex: history.length,
    unreadableReplies: 0,
    correctiveRounds: 0,
    notes: new Set(),
    compactionFailed: new Set(),
  };
}

/** Logs an info line unless a line with the same key was logged for this block. */
export function logOnce(conversation: Conversation, io: StepIO, line: string, key = line): void {
  if (conversation.notes.has(key)) return;
  conversation.notes.add(key);
  io.log('info', `${line}\n`);
}
