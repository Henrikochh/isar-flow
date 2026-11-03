/** Averages per block over the latest finished runs of a workflow (RunRecordSummary.blocks). */
import type { RunRecordSummary } from '@isar-flow/core';
import { count, isRecord } from './numbers';

export interface BlockTrend {
  /** Runs in which the block finished. */
  runs: number;
  durationMs: number;
  /** Input plus output tokens, averaged over the runs that reported them. */
  tokens?: number;
  /** Loop iterations, or executions of a block that ran more than once in some run, averaged over all runs. */
  iterations?: number;
}

export interface WorkflowTrends {
  /** Runs the averages are taken from. */
  runs: number;
  /** Blocks that finished in at least two of those runs. */
  blocks: Record<string, BlockTrend>;
}

const COUNTED = new Set(['success', 'failure', 'cancelled']);

interface Sums {
  runs: number;
  duration: number;
  tokens: number;
  tokenRuns: number;
  iterations: number;
  /** Runs that reported iterations: without any, the block never repeats and shows no average. */
  iterationRuns: number;
}

/** Block entries of a summary read from disk: anything that is not an object is left out. */
function blocksOf(run: RunRecordSummary): [string, Record<string, unknown>][] {
  const blocks: unknown = run.blocks;
  if (!isRecord(blocks)) return [];
  return Object.entries(blocks).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

/** Trends of the newest `limit` finished runs that carry block numbers; undefined until there are two. */
export function blockTrends(history: readonly RunRecordSummary[], limit = 20): WorkflowTrends | undefined {
  const runs = history
    .filter((run) => isRecord(run) && run.status !== 'running' && blocksOf(run).length > 0)
    .sort((a, b) => (count(b.startedAt) ?? 0) - (count(a.startedAt) ?? 0))
    .slice(0, limit);
  if (runs.length < 2) return undefined;

  const sums = new Map<string, Sums>();
  for (const run of runs) {
    for (const [id, block] of blocksOf(run)) {
      const duration = count(block.durationMs);
      // A skipped block with time ran in an earlier loop iteration of that run.
      const ran = COUNTED.has(String(block.status)) || (block.status === 'skipped' && !!duration);
      if (duration === undefined || !ran) continue;
      const sum = sums.get(id) ?? {
        runs: 0,
        duration: 0,
        tokens: 0,
        tokenRuns: 0,
        iterations: 0,
        iterationRuns: 0,
      };
      sum.runs += 1;
      sum.duration += duration;
      const input = count(block.inputTokens);
      const output = count(block.outputTokens);
      if (input !== undefined || output !== undefined) {
        sum.tokens += (input ?? 0) + (output ?? 0);
        sum.tokenRuns += 1;
      }
      // Loops always report iterations; other blocks report executions only when there were more than one.
      const iterations = count(block.iterations);
      sum.iterations += iterations ?? 1;
      if (iterations !== undefined) sum.iterationRuns += 1;
      sums.set(id, sum);
    }
  }

  const blocks: Record<string, BlockTrend> = {};
  for (const [id, sum] of sums) {
    if (sum.runs < 2) continue;
    const trend: BlockTrend = { runs: sum.runs, durationMs: sum.duration / sum.runs };
    if (sum.tokenRuns > 0) trend.tokens = sum.tokens / sum.tokenRuns;
    if (sum.iterationRuns > 0) trend.iterations = sum.iterations / sum.runs;
    blocks[id] = trend;
  }
  return { runs: runs.length, blocks };
}

/** "Last 20 runs", or fewer while the history is shorter. */
export function trendsLabel(runs: number): string {
  return `Last ${runs} ${runs === 1 ? 'run' : 'runs'}`;
}

/** Title of the trends table: "Average of the last 6 runs". */
export function trendsTitle(runs: number): string {
  return runs === 1 ? 'Average of the last run' : `Average of the last ${runs} runs`;
}
