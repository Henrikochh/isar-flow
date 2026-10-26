import type { Usage } from '../../src/engine/types';
import {
  type ChatMessage,
  type ChatModel,
  type ChatModelInfo,
  type ChatOptions,
  type ChatStreamEvent,
  type ModelCapabilities,
  ModelError,
  type ToolCall,
} from '../../src/models/types';

export interface FakeToolCall {
  id?: string;
  name: string;
  /** Objects are sent JSON-encoded; strings are sent verbatim (use this for malformed arguments). */
  args?: unknown;
}

/** One scripted model round-trip. */
export interface FakeTurn {
  /** Streamed as text events, in order. */
  text?: string | string[];
  toolCalls?: FakeToolCall[];
  usage?: Usage;
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'other';
  /** Thrown after the text chunks were streamed (e.g. a ModelError). */
  error?: Error;
  /** Runs right after the first text chunk was consumed (or at the start when there is none). */
  onStream?: () => void;
}

export interface RecordedChat {
  messages: ChatMessage[];
  options: ChatOptions;
}

export interface FakeModelInit {
  ref?: string;
  capabilities?: Partial<ModelCapabilities>;
}

/** A ChatModel that replays scripted turns and records every request it receives. */
export class FakeModel implements ChatModel {
  readonly ref: string;
  readonly provider: string;
  readonly providerLabel = 'Fake';
  readonly id: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  readonly calls: RecordedChat[] = [];
  private readonly turns: FakeTurn[];
  private callCount = 0;

  constructor(turns: FakeTurn[], init: FakeModelInit = {}) {
    this.turns = [...turns];
    this.ref = init.ref ?? 'fake/model';
    const slash = this.ref.indexOf('/');
    this.provider = this.ref.slice(0, slash);
    this.id = this.ref.slice(slash + 1);
    this.name = this.id;
    this.capabilities = { tools: true, jsonSchema: false, ...init.capabilities };
  }

  get info(): ChatModelInfo {
    return {
      ref: this.ref,
      provider: this.provider,
      providerLabel: this.providerLabel,
      id: this.id,
      name: this.name,
      capabilities: this.capabilities,
    };
  }

  /** Scripted turns that were not consumed. */
  get remainingTurns(): number {
    return this.turns.length;
  }

  async *chat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<ChatStreamEvent> {
    this.calls.push({ messages: structuredClone(messages), options: { ...options } });
    this.callCount++;
    const turn = this.turns.shift();
    if (!turn) throw new Error(`FakeModel ${this.ref} has no scripted turn left for call ${this.callCount}.`);

    const checkAbort = () => {
      if (options.signal?.aborted) throw new ModelError('The request was cancelled.', 'aborted');
    };
    await Promise.resolve();
    checkAbort();

    const chunks = typeof turn.text === 'string' ? [turn.text] : (turn.text ?? []);
    if (chunks.length === 0) turn.onStream?.();
    for (const [index, chunk] of chunks.entries()) {
      yield { type: 'text', text: chunk };
      if (index === 0) turn.onStream?.();
      checkAbort();
    }
    if (turn.error) throw turn.error;

    const calls = (turn.toolCalls ?? []).map((call, index): ToolCall => ({
      id: call.id ?? `call_${this.callCount}_${index + 1}`,
      name: call.name,
      arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
    }));
    for (const call of calls) {
      yield { type: 'tool-call', call };
      checkAbort();
    }
    if (turn.usage) yield { type: 'usage', ...turn.usage };
    yield { type: 'done', finishReason: turn.finishReason ?? (calls.length > 0 ? 'tool-calls' : 'stop') };
  }
}

/** Shorthand for a turn that answers with text. */
export function say(text: string | string[], usage?: Usage): FakeTurn {
  return { text, usage };
}

/** Shorthand for a turn that calls tools. */
export function callTools(...toolCalls: FakeToolCall[]): FakeTurn {
  return { toolCalls };
}
