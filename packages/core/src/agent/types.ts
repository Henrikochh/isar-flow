import type { StepIO, Usage } from '../engine/types';
import type { ChatMessage, ChatModel } from '../models/types';
import type { AgentPermissions, OutputShape, ToolName } from '../schema/types';

export interface ToolInvocation {
  name: string;
  /** Parsed arguments object. */
  args: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Executes built-in tools inside the workspace; implemented by the extension. */
export interface ToolHost {
  execute(call: ToolInvocation, io: StepIO, permissions: AgentPermissions): Promise<ToolResult>;
}

export interface AgentLoopOptions {
  model: ChatModel;
  systemPrompt?: string;
  /** Earlier conversation (session: continue). Does not include the system prompt. */
  history?: ChatMessage[];
  prompt: string;
  tools: ToolName[];
  toolHost?: ToolHost;
  permissions: AgentPermissions;
  /** Maximum model round-trips (default 20). */
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  output?: { format: 'text' | 'json'; schema?: OutputShape };
  io: StepIO;
}

export interface AgentLoopResult {
  text: string;
  json?: unknown;
  usage: Usage;
  turns: number;
  /** Conversation without the system prompt, ending with the final assistant message. */
  messages: ChatMessage[];
  model: string;
}
