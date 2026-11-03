import { extractJson } from '../agent/json';
import { sleep } from '../engine/timing';
import type {
  AgentRequest,
  AgentResult,
  ApprovalResult,
  ConsoleResult,
  SimulationHost,
  SimulationHostOptions,
  StepIO,
} from '../engine/types';
import type { SimulationResult } from '../schema/types';
import { sampleJson, SIMULATED_ANSWER } from './defaults';

/** The error of a cancelled call: the signal's reason when it is an error (timeouts keep their message). */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The simulated call was cancelled.');
  error.name = 'AbortError';
  return error;
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    // The engine passes the answer through without json, like a model that didn't answer in JSON.
    return undefined;
  }
}

const asLine = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

function agentAnswer(req: AgentRequest, result: SimulationResult): { text: string; json?: unknown } {
  if (req.output?.format !== 'json') return { text: result.text ?? SIMULATED_ANSWER };
  const json =
    result.json ??
    (result.text !== undefined ? parseJsonOrUndefined(result.text) : sampleJson(req.output.schema));
  const text = result.text ?? JSON.stringify(json, null, 2);
  return json === undefined ? { text } : { text, json };
}

/**
 * Engine host of a simulated run: answers every call from the simulation file's mocks (call n of a block uses
 * result n, the last one repeats) or the block's default. Never runs commands, calls models or touches files.
 */
export function createSimulationHost({ file, delayMs = 0 }: SimulationHostOptions): SimulationHost {
  const counts = new Map<string, number>();

  /** Counts the call, logs which mock answers it, waits the delay and fails it when the mock says so. */
  async function take(io: StepIO): Promise<SimulationResult> {
    const call = (counts.get(io.stepId) ?? 0) + 1;
    counts.set(io.stepId, call);
    if (io.signal.aborted) throw abortError(io.signal);
    const blocks = file.blocks ?? {};
    const mocks = Object.hasOwn(blocks, io.stepId) ? (blocks[io.stepId] ?? []) : [];
    const index = Math.min(call, mocks.length);
    if (index === 0) io.log('info', 'Simulated with the default result.\n');
    else if (call > mocks.length) {
      io.log('info', `Simulated: result ${index} of ${mocks.length} (the last result repeats).\n`);
    } else io.log('info', `Simulated: result ${index} of ${mocks.length}.\n`);
    if (delayMs > 0 && !(await sleep(delayMs, io.signal))) throw abortError(io.signal);
    const result = index === 0 ? {} : mocks[index - 1];
    if (result.error !== undefined) throw new Error(result.error);
    return result;
  }

  return {
    async runConsole(_req, io): Promise<ConsoleResult> {
      const result = await take(io);
      const output = result.output ?? '';
      if (output !== '') io.log('stdout', output);
      return { exitCode: result.exitCode ?? 0, stdout: output, stderr: '', output, timedOut: false };
    },

    async runAgent(req, io): Promise<AgentResult> {
      const { text, json } = agentAnswer(req, await take(io));
      if (text !== '') io.log('agent', asLine(text));
      return {
        text,
        ...(json !== undefined && { json }),
        model: req.agent.model,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        toolCalls: 0,
        messages: [
          ...req.history,
          { role: 'user', content: req.prompt },
          { role: 'assistant', content: text },
        ],
      };
    },

    async requestApproval(_req, io): Promise<ApprovalResult> {
      const result = await take(io);
      const approved = result.approved ?? file.approvals !== 'reject';
      io.log('info', `Answered automatically: ${approved ? 'approved' : 'rejected'}.\n`);
      return result.comment === undefined ? { approved } : { approved, comment: result.comment };
    },

    calls: () => Object.fromEntries(counts),
  };
}
