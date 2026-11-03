import type { AgentRequest, AgentResult, StepIO } from '../engine/types';
import { type ChatModel, ModelError, type ModelErrorKind, type ModelResolver } from '../models/types';
import { abortError, throwIfAborted } from './abort';
import { continueConversation, type Conversation, startConversation, withUsage } from './loop';
import type { ToolHost } from './types';

export interface ContextFile {
  /** Workspace-relative path, used as the label of the fenced block. */
  path: string;
  content: string;
}

export interface AgentRequestDeps {
  resolver: ModelResolver;
  io: StepIO;
  toolHost?: ToolHost;
  /** Reads the files matching workspace-relative globs; omitted where files cannot be read. */
  readContextFiles?: (globs: string[], signal: AbortSignal) => Promise<ContextFile[]>;
  /** Context size for compaction when a model reports no maxInputTokens (`isarFlow.agentContextTokens`). */
  contextTokens?: number;
}

/** Model problems that another model may not have. Auth, bad requests and cancels are never retried elsewhere. */
const FALLBACK_KINDS: ReadonlySet<ModelErrorKind> = new Set(['not-found', 'rate-limit', 'server', 'network']);
const FINAL_KINDS: ReadonlySet<ModelErrorKind> = new Set(['auth', 'bad-request', 'aborted']);

/**
 * Runs one agent block: attaches context files, then tries the agent's model and its fallback models in order.
 * A fallback model continues the conversation where the failed model stopped, so finished tool calls are not repeated;
 * `toolCalls` of the result counts the calls of every model. When the block fails after models used tokens, the
 * error is an AgentRunError with the usage of all models.
 */
export async function executeAgentRequest(
  request: AgentRequest,
  deps: AgentRequestDeps,
): Promise<AgentResult> {
  throwIfAborted(deps.io.signal);
  const prompt = await withContextFiles(request, deps);
  const conversation = startConversation({ history: request.history, prompt, output: request.output });
  try {
    return await answerWithFallbacks(request, deps, prompt, conversation);
  } catch (error) {
    throw withUsage(error, conversation.usage, conversation.toolCalls);
  }
}

async function answerWithFallbacks(
  request: AgentRequest,
  deps: AgentRequestDeps,
  prompt: string,
  conversation: Conversation,
): Promise<AgentResult> {
  const { io } = deps;
  const { agent } = request;
  const refs = [...new Set([agent.model, ...(agent.fallbackModels ?? [])])];
  const failures: { ref: string; error: unknown }[] = [];

  for (const [index, ref] of refs.entries()) {
    const next = refs[index + 1];
    const fail = (error: unknown, phase: 'resolve' | 'chat') => {
      if (io.signal.aborted) throw abortError(io.signal);
      if (!canFallBack(error, phase)) throw error;
      failures.push({ ref, error });
      if (next) {
        io.log(
          'info',
          `Model ${ref} failed: ${sentence(errorMessage(error))} Trying fallback model ${next}.\n`,
        );
      }
    };

    let model: ChatModel;
    try {
      model = await deps.resolver.resolve(ref);
    } catch (error) {
      fail(error, 'resolve');
      continue;
    }

    try {
      return await continueConversation(
        {
          model,
          systemPrompt: agent.systemPrompt,
          prompt,
          tools: agent.tools ?? [],
          toolHost: deps.toolHost,
          permissions: agent.permissions ?? {},
          toolMode: agent.toolMode,
          contextTokens: deps.contextTokens,
          maxTurns: agent.maxTurns,
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          output: request.output,
          io,
        },
        conversation,
      );
    } catch (error) {
      fail(error, 'chat');
    }
  }

  if (failures.length === 1) throw failures[0].error;
  const details = failures.map((f) => `${f.ref}: ${sentence(errorMessage(f.error))}`).join(' ');
  throw new Error(`No model could answer. ${details} Check the provider settings or choose other models.`, {
    cause: failures[failures.length - 1]?.error,
  });
}

/** Resolver errors usually mean "model unavailable"; errors while answering only for transient or missing models. */
function canFallBack(error: unknown, phase: 'resolve' | 'chat'): boolean {
  if (error instanceof ModelError) {
    return FALLBACK_KINDS.has(error.kind) || (phase === 'resolve' && !FINAL_KINDS.has(error.kind));
  }
  return phase === 'resolve';
}

async function withContextFiles(request: AgentRequest, deps: AgentRequestDeps): Promise<string> {
  const { io } = deps;
  const globs = request.contextFiles;
  if (globs.length === 0) return request.prompt;
  if (!deps.readContextFiles) {
    io.log('info', `Context files (${globs.join(', ')}) cannot be attached here; continuing without them.\n`);
    return request.prompt;
  }

  const files = await deps.readContextFiles(globs, io.signal);
  throwIfAborted(io.signal);
  if (files.length === 0) {
    io.log('info', `No files matched the context globs: ${globs.join(', ')}.\n`);
    return request.prompt;
  }

  const shown = files.slice(0, 5).map((f) => f.path);
  const more = files.length > shown.length ? ` and ${files.length - shown.length} more` : '';
  const noun = files.length === 1 ? 'file' : 'files';
  io.log('info', `Attached ${files.length} context ${noun}: ${shown.join(', ')}${more}.\n`);
  return `${request.prompt}\n\nContext files:\n\n${files.map(fenced).join('\n\n')}`;
}

/** A fenced block labelled with the path; the fence is longer than any backtick run inside the content. */
function fenced(file: ContextFile): string {
  // A loop, not Math.max(...runs): spreading hundreds of thousands of runs overflows the call stack.
  let longestRun = 0;
  for (const run of file.content.match(/`+/g) ?? []) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${file.path}\n${file.content.replace(/\r?\n$/, '')}\n${fence}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
