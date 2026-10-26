import type { ToolHost, ToolInvocation, ToolResult } from '../../src/agent/types';
import type { LogStream, StepIO } from '../../src/engine/types';
import type { AgentPermissions } from '../../src/schema/types';

export interface RecordingIO extends StepIO {
  logs: { stream: LogStream; text: string }[];
  controller: AbortController;
  /** Concatenated text logged to one stream. */
  textOf(stream: LogStream): string;
}

export function recordingIO(): RecordingIO {
  const controller = new AbortController();
  const logs: { stream: LogStream; text: string }[] = [];
  return {
    runId: 'run-1',
    stepId: 'step-1',
    signal: controller.signal,
    controller,
    logs,
    log(stream, text) {
      logs.push({ stream, text });
    },
    textOf(stream) {
      return logs
        .filter((l) => l.stream === stream)
        .map((l) => l.text)
        .join('');
    },
  };
}

type Handler = (call: ToolInvocation, io: StepIO) => ToolResult | Promise<ToolResult>;

/** Tool host that answers from per-tool handlers and records every call. */
export class FakeToolHost implements ToolHost {
  readonly calls: { call: ToolInvocation; permissions: AgentPermissions }[] = [];

  constructor(private readonly handlers: Record<string, Handler> = {}) {}

  async execute(call: ToolInvocation, io: StepIO, permissions: AgentPermissions): Promise<ToolResult> {
    this.calls.push({ call: structuredClone(call), permissions });
    const handler = this.handlers[call.name];
    if (!handler) return { content: `no handler for ${call.name}`, isError: true };
    return handler(call, io);
  }
}
