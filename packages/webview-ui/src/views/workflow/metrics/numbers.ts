/**
 * Time and tokens of one block in a run, read defensively: runs saved before Package A have no `metrics`, so the
 * latest output stands in for them, and history from disk may hold anything.
 */
import type { StepRunView } from '@isar-flow/core';

export interface BlockNumbers {
  /** Sum over all finished executions (older runs: the latest execution). */
  durationMs?: number;
  executions: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Model reference that answered the latest execution. */
  model?: string;
  turns?: number;
  toolCalls?: number;
  /** Loop blocks: iterations of the latest execution. */
  iterations?: number;
}

const FINISHED = new Set(['success', 'failure', 'cancelled']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Drops undefined fields so results compare and spread cleanly. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Numbers of a block that started in the run; undefined for blocks that were skipped or never started. A
 * running block keeps the totals of its finished executions (loops re-run blocks), and so does a block that ran in
 * an earlier loop iteration and was skipped in the last one. A reused block (Run from here) did not run in this run:
 * its output and numbers belong to the run it continues.
 */
export function blockNumbers(view: StepRunView | undefined): BlockNumbers | undefined {
  if (!view || view.reused) return undefined;
  const metrics = isRecord(view.metrics) ? view.metrics : undefined;
  if (!FINISHED.has(view.status) && !((view.status === 'running' || view.status === 'skipped') && metrics))
    return undefined;
  const source: Record<string, unknown> = metrics ?? {
    ...(isRecord(view.output) ? view.output : {}),
    durationMs: view.durationMs,
    executions: view.executions,
  };
  const usage = isRecord(source.usage) ? source.usage : undefined;
  const inputTokens = count(usage?.inputTokens);
  const outputTokens = count(usage?.outputTokens);
  const tokens = inputTokens !== undefined && outputTokens !== undefined;
  return defined({
    durationMs: count(source.durationMs),
    executions: count(source.executions) ?? count(view.executions) ?? 1,
    inputTokens: tokens ? inputTokens : undefined,
    outputTokens: tokens ? outputTokens : undefined,
    model: text(source.model),
    turns: count(source.turns),
    toolCalls: count(source.toolCalls),
    iterations: count(source.iterations),
  });
}

export function totalTokens(numbers: Pick<BlockNumbers, 'inputTokens' | 'outputTokens'>): number | undefined {
  return numbers.inputTokens === undefined || numbers.outputTokens === undefined
    ? undefined
    : numbers.inputTokens + numbers.outputTokens;
}

/** "3", "3.3": averages with at most one decimal. */
export function formatAverage(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
