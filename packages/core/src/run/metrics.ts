import type { StepOutput, Usage } from '../engine/types';
import { addUsage } from '../engine/usage';
import type { BlockRunMetrics, StepMetrics, StepRunView } from './types';

/** A count read from untyped output: finite and not negative, otherwise ignored. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageOf(output: StepOutput): Usage | undefined {
  const usage = output.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens = count(record.inputTokens);
  const outputTokens = count(record.outputTokens);
  return inputTokens === undefined || outputTokens === undefined ? undefined : { inputTokens, outputTokens };
}

const sum = (a: number | undefined, b: number | undefined) =>
  b === undefined ? a : a === undefined ? b : a + b;

/** Adds one finished execution (a step-end that is not skipped) to the block's totals. Pure. */
export function addExecution(
  previous: StepMetrics | undefined,
  durationMs: number,
  output: StepOutput,
): StepMetrics {
  const usage = usageOf(output);
  const model = typeof output.model === 'string' && output.model !== '' ? output.model : previous?.model;
  const turns = sum(previous?.turns, count(output.turns));
  const toolCalls = sum(previous?.toolCalls, count(output.toolCalls));
  const iterations = count(output.iterations) ?? previous?.iterations;
  const totalUsage = usage && previous?.usage ? addUsage(previous.usage, usage) : (usage ?? previous?.usage);
  return {
    durationMs: (previous?.durationMs ?? 0) + (count(durationMs) ?? 0),
    executions: (previous?.executions ?? 0) + 1,
    ...(totalUsage && { usage: totalUsage }),
    ...(model !== undefined && { model }),
    ...(turns !== undefined && { turns }),
    ...(toolCalls !== undefined && { toolCalls }),
    ...(iterations !== undefined && { iterations }),
  };
}

/** Per-block numbers for the history index; never copies text, logs or other outputs. */
export function blockRunMetrics(steps: Record<string, StepRunView>): Record<string, BlockRunMetrics> {
  const blocks: Record<string, BlockRunMetrics> = {};
  for (const [id, step] of Object.entries(steps)) {
    const metrics = step.metrics;
    if (!metrics) continue;
    const iterations = metrics.iterations ?? (metrics.executions > 1 ? metrics.executions : undefined);
    blocks[id] = {
      status: step.status,
      durationMs: metrics.durationMs,
      ...(metrics.usage && {
        inputTokens: metrics.usage.inputTokens,
        outputTokens: metrics.usage.outputTokens,
      }),
      ...(iterations !== undefined && { iterations }),
      ...(metrics.model !== undefined && { model: metrics.model }),
    };
  }
  return blocks;
}
