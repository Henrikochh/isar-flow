import type {
  AgentRequest,
  AgentResult,
  ApprovalRequest,
  ApprovalResult,
  ConsoleRequest,
  ConsoleResult,
  EngineHost,
  LogStream,
  StepIO,
  Usage,
} from '../../src/engine/types';
import type { ChatMessage } from '../../src/models/types';

/** Shared knobs for every scripted call. */
interface ScriptBase {
  /** Lines passed to io.log when the call starts. */
  logs?: { stream: LogStream; text: string }[];
  /** Wait this long before answering; aborting io.signal rejects early. */
  delayMs?: number;
  /** Never answer; rejects when io.signal aborts (unless ignoreAbort). */
  hang?: boolean;
  /** Keep waiting even after io.signal aborts (simulates a host that does not honor cancellation). */
  ignoreAbort?: boolean;
  /** Reject with this error instead of answering. */
  error?: string | Error;
}

export interface ConsoleScript extends ScriptBase {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  output?: string;
  timedOut?: boolean;
}

export interface AgentScript extends ScriptBase {
  text?: string;
  json?: unknown;
  model?: string;
  usage?: Partial<Usage>;
  turns?: number;
  messages?: ChatMessage[];
}

export interface ApprovalScript extends ScriptBase {
  approved?: boolean;
  comment?: string;
}

type Scripted<Req, S> = S | ((req: Req, io: StepIO) => S | Promise<S>);

export type HostCall =
  | { kind: 'console'; request: ConsoleRequest; io: StepIO }
  | { kind: 'agent'; request: AgentRequest; io: StepIO }
  | { kind: 'approval'; request: ApprovalRequest; io: StepIO };

class ScriptQueue<Req, S> {
  private readonly queues = new Map<string, Scripted<Req, S>[]>();

  add(key: string, scripts: Scripted<Req, S>[]): void {
    this.queues.set(key, [...(this.queues.get(key) ?? []), ...scripts]);
  }

  /** Takes the next script for the first key that has one; the last script of a key is reused. */
  take(keys: (string | undefined)[]): Scripted<Req, S> | undefined {
    for (const key of keys) {
      if (key === undefined) continue;
      const queue = this.queues.get(key);
      if (!queue || queue.length === 0) continue;
      return queue.length > 1 ? queue.shift() : queue[0];
    }
    return undefined;
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function wait(ms: number | undefined, signal: AbortSignal, ignoreAbort: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const forever = ms === undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(abortError());
    };
    const timer = forever
      ? undefined
      : setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
    if (ignoreAbort) return;
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function play<Req, S extends ScriptBase>(
  script: Scripted<Req, S> | undefined,
  req: Req,
  io: StepIO,
): Promise<S> {
  const resolved = typeof script === 'function' ? await script(req, io) : (script ?? ({} as S));
  for (const line of resolved.logs ?? []) io.log(line.stream, line.text);
  const ignoreAbort = resolved.ignoreAbort ?? false;
  if (resolved.hang) await wait(undefined, io.signal, ignoreAbort);
  else if (resolved.delayMs !== undefined) await wait(resolved.delayMs, io.signal, ignoreAbort);
  if (resolved.error !== undefined) {
    throw typeof resolved.error === 'string' ? new Error(resolved.error) : resolved.error;
  }
  return resolved;
}

/**
 * Scriptable EngineHost for engine tests. Scripts are queued per step id (preferred), command, or agent id;
 * once a queue is down to its last script, that script answers every further call.
 * Unscripted calls succeed: exit code 0, agent text 'ok', approval granted.
 */
export class FakeHost implements EngineHost {
  readonly calls: HostCall[] = [];
  private readonly consoleScripts = new ScriptQueue<ConsoleRequest, ConsoleScript>();
  private readonly agentScripts = new ScriptQueue<AgentRequest, AgentScript>();
  private readonly approvalScripts = new ScriptQueue<ApprovalRequest, ApprovalScript>();

  /** Scripts console results for a step id or an exact (rendered) command. */
  console(key: string, ...scripts: Scripted<ConsoleRequest, ConsoleScript>[]): this {
    this.consoleScripts.add(key, scripts);
    return this;
  }

  /** Scripts agent results for a step id or an agent file id. */
  agent(key: string, ...scripts: Scripted<AgentRequest, AgentScript>[]): this {
    this.agentScripts.add(key, scripts);
    return this;
  }

  /** Scripts approval answers for a step id. */
  approval(key: string, ...scripts: Scripted<ApprovalRequest, ApprovalScript>[]): this {
    this.approvalScripts.add(key, scripts);
    return this;
  }

  get consoleCalls(): ConsoleRequest[] {
    return this.calls.flatMap((c) => (c.kind === 'console' ? [c.request] : []));
  }

  get agentCalls(): AgentRequest[] {
    return this.calls.flatMap((c) => (c.kind === 'agent' ? [c.request] : []));
  }

  get approvalCalls(): ApprovalRequest[] {
    return this.calls.flatMap((c) => (c.kind === 'approval' ? [c.request] : []));
  }

  /** Step ids in call order, e.g. ['tests', 'review', 'tests']. */
  get callOrder(): string[] {
    return this.calls.map((c) => c.request.stepId);
  }

  async runConsole(request: ConsoleRequest, io: StepIO): Promise<ConsoleResult> {
    this.calls.push({ kind: 'console', request, io });
    const s = await play(this.consoleScripts.take([request.stepId, request.command]), request, io);
    const stdout = s.stdout ?? '';
    const stderr = s.stderr ?? '';
    return {
      exitCode: s.exitCode ?? 0,
      stdout,
      stderr,
      output: s.output ?? stdout + stderr,
      timedOut: s.timedOut ?? false,
    };
  }

  async runAgent(request: AgentRequest, io: StepIO): Promise<AgentResult> {
    this.calls.push({ kind: 'agent', request, io });
    const s = await play(this.agentScripts.take([request.stepId, request.agentId]), request, io);
    const text = s.text ?? (s.json !== undefined ? JSON.stringify(s.json) : 'ok');
    return {
      text,
      json: s.json,
      model: s.model ?? request.agent.model,
      usage: { inputTokens: s.usage?.inputTokens ?? 0, outputTokens: s.usage?.outputTokens ?? 0 },
      turns: s.turns ?? 1,
      messages: s.messages ?? [
        ...request.history,
        { role: 'user', content: request.prompt },
        { role: 'assistant', content: text },
      ],
    };
  }

  async requestApproval(request: ApprovalRequest, io: StepIO): Promise<ApprovalResult> {
    this.calls.push({ kind: 'approval', request, io });
    const s = await play(this.approvalScripts.take([request.stepId]), request, io);
    return s.comment === undefined
      ? { approved: s.approved ?? true }
      : { approved: s.approved ?? true, comment: s.comment };
  }
}
