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
  /** Project memory of this conversation (agent setting `memory`); omitted = no memory. */
  memory?: AgentMemory;
}

/**
 * Project memory as one agent conversation sees it (built by executeAgentRequest from ProjectMemory).
 * `remember` is not a ToolName: it is never listed in an agent's `tools` and never reaches the ToolHost.
 */
export interface AgentMemory {
  /**
   * Text of `.isarflow/memory.md`, already cut to the first 8 KB (UTF-8, at a character boundary); added to the
   * system prompt under a "Project memory" heading. Missing or blank = no memory section.
   */
  text?: string;
  /** True when `text` was cut; the prompt then says that only the beginning of the file is shown. */
  truncated?: boolean;
  /**
   * memory: write. Offers the tool `remember(note)` (natively, or in the text tool section in text tool mode);
   * the agent loop answers its calls with this function instead of the ToolHost. Resolves with the line written;
   * a rejection becomes a tool error result for the model (the block does not fail).
   */
  remember?: (note: string, io: StepIO) => Promise<string>;
}

/**
 * The project memory file (`.isarflow/memory.md`) of a run's workspace folder; implemented by the hosts (VS Code
 * extension and command line runner) and passed to executeAgentRequest (`AgentRequestDeps.memory`), which turns it
 * into AgentMemory for agents with `memory: read | write` (default read).
 */
export interface ProjectMemory {
  /**
   * Text of the file (the whole file; the caller cuts it to 8 KB); undefined when it does not exist. A rejection is
   * logged and the agent runs without memory.
   */
  read(signal: AbortSignal): Promise<string | undefined>;
  /**
   * Appends `note` as a dated bullet (`- 2026-11-03: <note>`, see memoryNoteLine), creating the file with a short
   * header when missing. Resolves with the line written; rejects with a user-facing message (see
   * checkMemoryNote: empty or too long note, a secret in the note; file over the size limit; write failed), which
   * the agent receives as a tool error.
   */
  append(note: string, io: StepIO): Promise<string>;
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
