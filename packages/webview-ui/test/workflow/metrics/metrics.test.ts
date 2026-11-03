import type { RunRecordSummary, RunView, StepRunView } from '@isar-flow/core';
import { describe, expect, it } from 'vitest';
import { formatCost } from '../../../src/hooks';
import {
  blockNumbers,
  blockTrends,
  estimateCost,
  formatAverage,
  runCost,
  trendsLabel,
  trendsTitle,
} from '../../../src/views/workflow/metrics';

const PRICES = {
  'litellm/claude-sonnet': { input: 3, output: 15 },
  'vscode/copilot/gpt-4.1': { input: 2, output: 8 },
};

describe('estimateCost', () => {
  it('prices input and output tokens per million', () => {
    expect(
      estimateCost({ inputTokens: 10_000, outputTokens: 2_000 }, 'litellm/claude-sonnet', PRICES),
    ).toBeCloseTo(0.06);
  });

  it('is undefined without usage, model or price', () => {
    expect(estimateCost(undefined, 'litellm/claude-sonnet', PRICES)).toBeUndefined();
    expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, undefined, PRICES)).toBeUndefined();
    expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, 'litellm/llama', PRICES)).toBeUndefined();
    expect(
      estimateCost({ inputTokens: 1, outputTokens: 1 }, 'litellm/claude-sonnet', undefined),
    ).toBeUndefined();
  });

  it('ignores prices that are not usable numbers', () => {
    const odd = { 'a/b': { input: Number.NaN, output: 1 }, 'a/c': { input: -1, output: 1 } };
    expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, 'a/b', odd)).toBeUndefined();
    expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, 'a/c', odd)).toBeUndefined();
  });
});

describe('formatCost', () => {
  it('shows two decimals, and two significant digits below a cent', () => {
    expect(formatCost(0.0412)).toBe('0.04');
    expect(formatCost(1.5)).toBe('1.50');
    expect(formatCost(12.345)).toBe('12.35');
    expect(formatCost(0.0034)).toBe('0.0034');
    expect(formatCost(0.000123)).toBe('0.00012');
    expect(formatCost(0)).toBe('0.00');
  });

  it('never prints scientific notation for tiny amounts', () => {
    expect(formatCost(1e-9)).toBe('< 0.000001');
  });
});

function step(overrides: Partial<StepRunView>): StepRunView {
  return { status: 'success', executions: 1, logs: [], ...overrides };
}

describe('blockNumbers', () => {
  it('reads the totals of a block', () => {
    const numbers = blockNumbers(
      step({
        executions: 3,
        durationMs: 900,
        metrics: {
          durationMs: 3200,
          executions: 3,
          usage: { inputTokens: 3000, outputTokens: 400 },
          model: 'litellm/claude-sonnet',
          turns: 7,
          toolCalls: 12,
        },
      }),
    );
    expect(numbers).toEqual({
      durationMs: 3200,
      executions: 3,
      inputTokens: 3000,
      outputTokens: 400,
      model: 'litellm/claude-sonnet',
      turns: 7,
      toolCalls: 12,
    });
  });

  it('falls back to the latest output of runs saved before metrics existed', () => {
    const numbers = blockNumbers(
      step({
        durationMs: 1700,
        output: {
          status: 'success',
          model: 'litellm/claude-sonnet',
          usage: { inputTokens: 18_400, outputTokens: 1_250 },
          turns: 4,
        },
      }),
    );
    expect(numbers).toEqual({
      durationMs: 1700,
      executions: 1,
      inputTokens: 18_400,
      outputTokens: 1_250,
      model: 'litellm/claude-sonnet',
      turns: 4,
    });
  });

  it('reads loop iterations and ignores malformed values', () => {
    expect(
      blockNumbers(step({ metrics: { durationMs: 5000, executions: 1, iterations: 4 } }))?.iterations,
    ).toBe(4);
    expect(
      blockNumbers(step({ durationMs: 10, output: { status: 'success', iterations: 2 } }))?.iterations,
    ).toBe(2);
    const odd = blockNumbers(
      step({
        metrics: {
          durationMs: Number.NaN,
          executions: 1,
          usage: { inputTokens: '3' } as never,
          model: 4 as never,
        },
      }),
    );
    expect(odd).toEqual({ executions: 1 });
  });

  it('keeps the totals of a block that ran in an earlier loop iteration and was skipped in the last one', () => {
    const numbers = blockNumbers(
      step({
        status: 'skipped',
        metrics: { durationMs: 3400, executions: 1, usage: { inputTokens: 12_000, outputTokens: 900 } },
      }),
    );
    expect(numbers).toEqual({ durationMs: 3400, executions: 1, inputTokens: 12_000, outputTokens: 900 });
  });

  it('has nothing for blocks that did not finish', () => {
    expect(blockNumbers(undefined)).toBeUndefined();
    expect(blockNumbers(step({ status: 'skipped' }))).toBeUndefined();
    expect(blockNumbers(step({ status: 'pending' }))).toBeUndefined();
  });
});

function run(steps: Record<string, StepRunView>): RunView {
  return {
    runId: 'r',
    workflowName: 'W',
    status: 'success',
    startedAt: 0,
    inputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    steps,
  };
}

describe('runCost', () => {
  it('sums the priced blocks and names the models without a price', () => {
    const result = runCost(
      run({
        a: step({
          metrics: {
            durationMs: 1,
            executions: 1,
            usage: { inputTokens: 10_000, outputTokens: 2_000 },
            model: 'litellm/claude-sonnet',
          },
        }),
        b: step({
          metrics: {
            durationMs: 1,
            executions: 1,
            usage: { inputTokens: 100_000, outputTokens: 0 },
            model: 'vscode/copilot/gpt-4.1',
          },
        }),
        c: step({
          metrics: {
            durationMs: 1,
            executions: 1,
            usage: { inputTokens: 5, outputTokens: 5 },
            model: 'x/llama',
          },
        }),
        d: step({
          metrics: {
            durationMs: 1,
            executions: 1,
            usage: { inputTokens: 5, outputTokens: 5 },
            model: 'x/qwen',
          },
        }),
        e: step({ metrics: { durationMs: 1, executions: 1 } }),
      }),
      PRICES,
    );
    expect(result.cost).toBeCloseTo(0.26);
    expect(result.unpriced).toEqual(['x/llama', 'x/qwen']);
  });

  it('has no cost when no model of the run is priced', () => {
    const result = runCost(
      run({
        a: step({
          metrics: {
            durationMs: 1,
            executions: 1,
            usage: { inputTokens: 5, outputTokens: 5 },
            model: 'x/llama',
          },
        }),
      }),
      undefined,
    );
    expect(result).toEqual({ cost: undefined, unpriced: ['x/llama'] });
  });
});

function summary(id: string, startedAt: number, blocks?: RunRecordSummary['blocks']): RunRecordSummary {
  return { runId: id, workflowUri: 'w', workflowName: 'W', status: 'success', startedAt, blocks };
}

describe('blockTrends', () => {
  it('averages time, tokens and iterations per block over the newest runs', () => {
    const trends = blockTrends(
      [
        summary('1', 100, {
          implement: {
            status: 'success',
            durationMs: 60_000,
            inputTokens: 3000,
            outputTokens: 0,
            model: 'm',
          },
          loop: { status: 'success', durationMs: 90_000, iterations: 2 },
          tests: { status: 'failure', durationMs: 4000 },
        }),
        summary('2', 300, {
          implement: { status: 'success', durationMs: 68_000, inputTokens: 3000, outputTokens: 200 },
          loop: { status: 'success', durationMs: 50_000, iterations: 4 },
        }),
        summary('old', 50, {
          implement: { status: 'success', durationMs: 1, inputTokens: 1, outputTokens: 1 },
        }),
      ],
      2,
    );
    expect(trends?.runs).toBe(2);
    expect(trends?.blocks.implement).toEqual({ runs: 2, durationMs: 64_000, tokens: 3100 });
    expect(trends?.blocks.loop).toEqual({ runs: 2, durationMs: 70_000, iterations: 3 });
    // A block that ran once has no trend yet.
    expect(trends?.blocks.tests).toBeUndefined();
  });

  it('counts a run in which a block ran once in the average of how often it ran', () => {
    // The history reports executions only when there were more than one.
    const trends = blockTrends([
      summary('1', 1, { tests: { status: 'success', durationMs: 1000, iterations: 3 } }),
      summary('2', 2, { tests: { status: 'success', durationMs: 1000 } }),
      summary('3', 3, { implement: { status: 'success', durationMs: 1000 } }),
      summary('4', 4, { implement: { status: 'success', durationMs: 1000 } }),
    ]);
    expect(trends?.blocks.tests.iterations).toBe(2);
    expect(trends?.blocks.implement.iterations).toBeUndefined();
  });

  it('counts a block that ran in a run whose last loop iteration skipped it', () => {
    const trends = blockTrends([
      summary('1', 1, { fix: { status: 'skipped', durationMs: 3000, inputTokens: 100, outputTokens: 20 } }),
      summary('2', 2, { fix: { status: 'success', durationMs: 5000, inputTokens: 300, outputTokens: 60 } }),
      // A skipped block without time never ran.
      summary('3', 3, { fix: { status: 'skipped', durationMs: 0 } }),
    ]);
    expect(trends?.blocks.fix).toEqual({ runs: 2, durationMs: 4000, tokens: 240 });
  });

  it('needs two finished runs with block numbers', () => {
    expect(blockTrends([])).toBeUndefined();
    expect(
      blockTrends([
        summary('1', 1, { a: { status: 'success', durationMs: 1 } }),
        summary('2', 2),
        { ...summary('3', 3, { a: { status: 'success', durationMs: 1 } }), status: 'running' },
        summary('4', 4, {}),
      ]),
    ).toBeUndefined();
  });

  it('skips malformed entries', () => {
    const trends = blockTrends([
      summary('1', 1, { a: { status: 'success', durationMs: 1000 }, b: null as never }),
      summary('2', 2, {
        a: { status: 'success', durationMs: 'x' as never },
        c: { status: 'skipped', durationMs: 0 },
      }),
      summary('3', 3, { a: { status: 'success', durationMs: 3000 } }),
    ]);
    expect(trends?.runs).toBe(3);
    expect(trends?.blocks).toEqual({ a: { runs: 2, durationMs: 2000 } });
  });

  it('uses at most the last twenty runs by default', () => {
    const history = Array.from({ length: 25 }, (_, i) =>
      summary(String(i), i, { a: { status: 'success', durationMs: i < 5 ? 1_000_000 : 1000 } }),
    );
    const trends = blockTrends(history);
    expect(trends?.runs).toBe(20);
    expect(trends?.blocks.a.durationMs).toBe(1000);
  });
});

describe('labels', () => {
  it('names the window of runs', () => {
    expect(trendsLabel(20)).toBe('Last 20 runs');
    expect(trendsLabel(6)).toBe('Last 6 runs');
  });

  it('says that the trends table shows averages', () => {
    expect(trendsTitle(6)).toBe('Average of the last 6 runs');
    expect(trendsTitle(1)).toBe('Average of the last run');
  });

  it('formats averages with at most one decimal', () => {
    expect(formatAverage(3)).toBe('3');
    expect(formatAverage(3.25)).toBe('3.3');
    expect(formatAverage(2.04)).toBe('2');
  });
});
