import {
  type AgentDefinition,
  type AgentPermissions,
  type AgentRequest,
  type AgentRequestDeps,
  type AgentResult,
  type ChatMessage,
  type Diagnostic,
  executeAgentRequest,
  type ModelResolver,
  type PermissionLevel,
  type ResolvedAgent,
  type StepIO,
  type ToolHost,
  type TryItEvent,
} from '@isar-flow/core';

export interface TryItTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** The parts of an agent document state needed for a try (see buildAgentDocumentState). */
export interface TryItSource {
  id: string;
  agent: AgentDefinition | null;
  valid: boolean;
  diagnostics: Diagnostic[];
}

export type TryItBuild = { ok: true; request: AgentRequest } | { ok: false; error: string };

const SETTING_KEYS = [
  'fallbackModels',
  'systemPrompt',
  'temperature',
  'maxTokens',
  'maxTurns',
  'tools',
  'toolMode',
] as const;

/** Try it never lets tools act without asking: `auto` becomes `ask`. */
function safePermissions(permissions: AgentPermissions): AgentPermissions {
  const safe = (level: PermissionLevel | undefined) => (level === 'auto' ? 'ask' : level);
  const result: AgentPermissions = {};
  if (permissions.edits !== undefined) result.edits = safe(permissions.edits);
  if (permissions.commands !== undefined) result.commands = safe(permissions.commands);
  return result;
}

function describeProblem(diagnostics: Diagnostic[]): string | undefined {
  const problem = diagnostics.find((d) => d.severity === 'error');
  if (!problem) return undefined;
  const message = problem.message.replace(/[.\s]+$/, '');
  return problem.range ? `${message} (line ${problem.range.start.line + 1})` : message;
}

/**
 * Builds the Try it request from the current (possibly unsaved) agent document and the transcript so far.
 * Returns a message for the user instead when the agent cannot be tried as it is.
 */
export function buildTryItRequest(source: TryItSource, prompt: string, history: TryItTurn[]): TryItBuild {
  const { agent } = source;
  if (!agent) {
    const problem = describeProblem(source.diagnostics);
    const reason = problem ? `The agent file can't be read: ${problem}.` : "The agent file can't be read.";
    return { ok: false, error: `${reason} Fix it in the YAML, then try again.` };
  }
  if (typeof agent.model !== 'string' || agent.model.trim() === '') {
    return { ok: false, error: 'Choose a model for this agent before trying it.' };
  }
  if (!source.valid) {
    const problem = describeProblem(source.diagnostics) ?? 'it has errors';
    return { ok: false, error: `Fix the agent file before trying it: ${problem}.` };
  }
  if (prompt.trim() === '') return { ok: false, error: 'Type a message for the agent.' };

  const name = typeof agent.name === 'string' && agent.name.trim() !== '' ? agent.name : source.id;
  const resolved: ResolvedAgent = { name, model: agent.model };
  for (const key of SETTING_KEYS) {
    if (agent[key] !== undefined) Object.assign(resolved, { [key]: agent[key] });
  }
  if (agent.permissions) resolved.permissions = safePermissions(agent.permissions);

  const messages: ChatMessage[] = history
    .filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && turn.content.trim() !== '')
    .map((turn) => ({ role: turn.role, content: turn.content }));

  return {
    ok: true,
    request: {
      stepId: 'try-it',
      agentId: source.id,
      agent: resolved,
      prompt,
      history: messages,
      output: undefined,
      contextFiles: [],
    },
  };
}

/** Parses a `tool` log line of the agent loop (`<tool> <args> → <result>`). */
export function parseToolLogLine(line: string): Extract<TryItEvent, { type: 'tool' }> {
  const text = line.replace(/\r?\n$/, '');
  const arrow = text.indexOf(' → ');
  const call = arrow >= 0 ? text.slice(0, arrow) : text;
  const space = call.indexOf(' ');
  const event: Extract<TryItEvent, { type: 'tool' }> = {
    type: 'tool',
    name: space >= 0 ? call.slice(0, space) : call,
    args: space >= 0 ? call.slice(space + 1) : '',
  };
  if (arrow >= 0) {
    event.result = text.slice(arrow + 3);
    if (event.result.startsWith('failed: ')) event.isError = true;
  }
  return event;
}

export interface TryItDeps {
  resolver: ModelResolver;
  /** Creates the permission-gated tool host for one try. */
  tools: (runId: string) => ToolHost;
  /** Receives informational lines (e.g. fallback model notes). */
  info?: (text: string) => void;
  now?: () => number;
  /** Context size for models that report none (setting isarFlow.agentContextTokens), read at each try. */
  contextTokens?: () => number | undefined;
  /** Runs the agent; replaced in tests. */
  execute?: (request: AgentRequest, deps: AgentRequestDeps) => Promise<AgentResult>;
}

/** Runs Try it conversations for one agent editor, one at a time. */
export class TryItSession {
  private current: AbortController | undefined;

  constructor(
    private readonly deps: TryItDeps,
    private readonly emit: (event: TryItEvent) => void,
  ) {}

  get running(): boolean {
    return this.current !== undefined;
  }

  /** Starts a try; a try that is still running is stopped without further events. */
  async start(request: AgentRequest): Promise<void> {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    const live = () => this.current === controller;
    const emit = (event: TryItEvent) => {
      if (live()) this.emit(event);
    };
    const runId = `try-${(this.deps.now ?? Date.now)()}`;
    const io: StepIO = {
      runId,
      stepId: request.stepId,
      signal: controller.signal,
      log: (stream, text) => {
        if (stream === 'agent') emit({ type: 'text', text });
        else if (stream === 'tool') {
          for (const line of text.split('\n')) if (line.trim() !== '') emit(parseToolLogLine(line));
        } else if (live()) this.deps.info?.(text);
      },
    };
    try {
      const deps: AgentRequestDeps = { resolver: this.deps.resolver, io, toolHost: this.deps.tools(runId) };
      const contextTokens = this.deps.contextTokens?.();
      if (contextTokens !== undefined) deps.contextTokens = contextTokens;
      const result = await (this.deps.execute ?? executeAgentRequest)(request, deps);
      emit({ type: 'done', usage: result.usage, model: result.model });
    } catch (error) {
      const message = controller.signal.aborted
        ? 'Stopped.'
        : error instanceof Error
          ? error.message
          : String(error);
      emit({ type: 'error', message });
    } finally {
      if (live()) this.current = undefined;
    }
  }

  /** Stops the running try; it ends with an error event "Stopped.". */
  cancel(): void {
    this.current?.abort();
  }

  /** Stops the running try without further events. */
  dispose(): void {
    const controller = this.current;
    this.current = undefined;
    controller?.abort();
  }
}
