import type { StepIO, Usage } from '../engine/types';
import type { ChatMessage, ChatModel } from '../models/types';
import type { AgentPermissions, OutputShape, ToolMode, ToolName } from '../schema/types';

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
  /** How tools are offered to the model (default 'auto'); see ToolMode. */
  toolMode?: ToolMode;
  /**
   * Context size used for compaction when the model does not report `maxInputTokens` (setting
   * `isarFlow.agentContextTokens`, default 24000). The oldest turns are summarized above 70 % of it.
   */
  contextTokens?: number;
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
  /** Tool calls executed, native and repaired ones (refused calls included). */
  toolCalls?: number;
  /** Conversation without the system prompt, ending with the final assistant message. */
  messages: ChatMessage[];
  model: string;
}
