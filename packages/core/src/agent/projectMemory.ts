import type { AgentRequest, StepIO } from '../engine/types';
import { abortError } from './abort';
import { errorMessage, withoutPeriod } from './format';
import { capMemoryText } from './memory';
import type { AgentMemory, ProjectMemory } from './types';

/**
 * The project memory one agent block sees (agent setting `memory`, default read): the file read once, cut to 8 KB,
 * and with memory write the remember function. Undefined when the agent gets no memory.
 */
export async function agentMemory(
  request: AgentRequest,
  memory: ProjectMemory | undefined,
  io: StepIO,
): Promise<AgentMemory | undefined> {
  const mode = request.agent.memory ?? 'read';
  if (mode === 'none') return undefined;
  if (!memory) {
    if (mode === 'write') io.log('info', "Project memory isn't available here.\n");
    return undefined;
  }

  const result: AgentMemory = {};
  const text = await readMemory(memory, io);
  if (text !== undefined && text.trim() !== '') {
    const capped = capMemoryText(text);
    io.log('info', `Read the project memory (${formatSize(new TextEncoder().encode(text).length)}).\n`);
    result.text = capped.text;
    if (capped.truncated) {
      result.truncated = true;
      io.log('info', 'The project memory is larger than 8 KB; the agent sees the first 8 KB.\n');
    }
  }
  if (mode === 'write') result.remember = (note, noteIo) => memory.append(note, noteIo);
  return result.text !== undefined || result.remember ? result : undefined;
}

async function readMemory(memory: ProjectMemory, io: StepIO): Promise<string | undefined> {
  try {
    return await memory.read(io.signal);
  } catch (error) {
    if (io.signal.aborted) throw abortError(io.signal);
    io.log(
      'info',
      `Could not read the project memory: ${withoutPeriod(errorMessage(error))}. Continuing without it.\n`,
    );
    return undefined;
  }
}

/** "340 bytes", "2.1 KB", "8 KB". */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
}
