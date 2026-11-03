import { fireEvent, screen, within } from '@testing-library/react';
import type { ModelCatalog, RunRecordSummary, RunView, StepRunView } from '@isar-flow/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { CATALOG } from '../../../harness/fixtures';
import { renderInspector, resetPosted } from './helpers';

beforeEach(resetPosted);

const PRICED: ModelCatalog = {
  ...CATALOG,
  prices: { 'litellm/claude-sonnet': { input: 10, output: 25 } },
};

function step(overrides: Partial<StepRunView>): StepRunView {
  return { status: 'success', executions: 1, logs: [], ...overrides };
}

const LONG_MODEL = 'litellm/bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0-with-a-very-long-suffix';

function makeRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-9',
    workflowName: 'Review until approved',
    status: 'success',
    startedAt: Date.now() - 120_000,
    durationMs: 95_000,
    inputs: { task: 'Add voucher codes' },
    usage: { inputTokens: 13_900, outputTokens: 2_500 },
    steps: {
      implement: step({
        durationMs: 4200,
        output: { status: 'success', text: 'Done.', model: 'litellm/claude-sonnet' },
        metrics: {
          durationMs: 4200,
          executions: 1,
          usage: { inputTokens: 10_000, outputTokens: 2_000 },
          model: 'litellm/claude-sonnet',
          turns: 4,
          toolCalls: 6,
        },
      }),
      review_loop: step({
        loop: { iteration: 3, maxIterations: 5 },
        metrics: { durationMs: 61_000, executions: 1, iterations: 3 },
      }),
      tests: step({
        status: 'failure',
        executions: 3,
        durationMs: 1000,
        metrics: { durationMs: 3600, executions: 3 },
      }),
      review: step({
        executions: 3,
        durationMs: 3000,
        output: { status: 'success', text: '{}', json: { approved: true } },
        metrics: {
          durationMs: 9000,
          executions: 3,
          usage: { inputTokens: 3900, outputTokens: 500 },
          model: LONG_MODEL,
          turns: 3,
          toolCalls: 2,
        },
      }),
      needs_fix: step({ executions: 3, metrics: { durationMs: 30, executions: 3 } }),
      fix: step({ status: 'skipped' }),
    },
    ...overrides,
  };
}

function past(id: string, minutesAgo: number, blocks: RunRecordSummary['blocks']): RunRecordSummary {
  return {
    runId: id,
    workflowUri: 'file:///w/review-loop.workflow.yaml',
    workflowName: 'Review until approved',
    status: 'success',
    startedAt: Date.now() - minutesAgo * 60_000,
    blocks,
  };
}

const HISTORY: RunRecordSummary[] = [
  past('a', 10, {
    implement: { status: 'success', durationMs: 60_000, inputTokens: 3000, outputTokens: 0 },
    review_loop: { status: 'success', durationMs: 50_000, iterations: 2 },
  }),
  past('b', 60, {
    implement: { status: 'success', durationMs: 68_000, inputTokens: 3000, outputTokens: 200 },
    review_loop: { status: 'success', durationMs: 70_000, iterations: 4 },
  }),
];

const rowOf = (table: HTMLElement, name: RegExp) =>
  within(table)
    .getAllByRole('row')
    .find((row) => within(row).queryByRole('button', { name }) ?? within(row).queryByText(name));

describe('Run summary table', () => {
  it('lists every block with status, time, tokens, model and iterations', () => {
    renderInspector({ run: makeRun(), runLive: false, catalog: PRICED, history: [] });
    const table = screen.getByRole('table', { name: 'Blocks in this run' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Status', 'Block', 'Model', 'Time', 'Tokens', 'Iterations']);
    const implement = rowOf(table, /^implement/) as HTMLElement;
    expect(
      within(implement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['', 'implement', 'litellm/claude-sonnet', '4.2 s', '12k', '']);
    expect(within(implement).getByRole('img', { name: 'Succeeded' })).toBeInTheDocument();

    const loop = rowOf(table, /^review_loop/) as HTMLElement;
    expect(within(loop).getAllByRole('cell').at(-1)).toHaveTextContent('×3');
    const tests = rowOf(table, /^tests/) as HTMLElement;
    expect(within(tests).getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(within(tests).getAllByRole('cell').at(-1)).toHaveTextContent('×3');

    const review = rowOf(table, /^review:/) as HTMLElement;
    const model = within(review).getByText(LONG_MODEL);
    expect(model).toHaveAttribute('title', LONG_MODEL);
    expect(model.tagName).toBe('CODE');

    const fix = rowOf(table, /^fix/) as HTMLElement;
    expect(fix).toHaveClass('wf-run-river-item--quiet');
    expect(within(fix).getByRole('img', { name: 'Skipped' })).toBeInTheDocument();
  });

  it('selects a block from its row', () => {
    renderInspector({ run: makeRun(), runLive: false, catalog: PRICED });
    const table = screen.getByRole('table', { name: 'Blocks in this run' });
    fireEvent.click(within(table).getByRole('button', { name: 'tests: Failed' }));
    expect(screen.getByRole('tab', { name: /Run output/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Id/ })).toHaveValue('tests');
  });

  it('selects a block when its row is clicked anywhere', () => {
    renderInspector({ run: makeRun(), runLive: false, catalog: PRICED });
    const table = screen.getByRole('table', { name: 'Blocks in this run' });
    fireEvent.click(within(rowOf(table, /^implement/) as HTMLElement).getByText('4.2 s'));
    expect(screen.getByRole('textbox', { name: /Id/ })).toHaveValue('implement');
  });

  it('totals tokens and cost and names the models without a price', () => {
    renderInspector({ run: makeRun(), runLive: false, catalog: PRICED });
    expect(screen.getByText('14k in')).toBeInTheDocument();
    expect(screen.getByText('2.5k out')).toBeInTheDocument();
    expect(screen.getByText('Cost 0.15')).toHaveAttribute('title', 'Estimated from isarFlow.modelPrices');
    const unpriced = screen.getByText('1 model without price');
    expect(unpriced.getAttribute('title')).toContain(LONG_MODEL);
  });

  it('shows no cost without prices', () => {
    renderInspector({ run: makeRun(), runLive: false, catalog: { ...CATALOG, prices: undefined } });
    expect(screen.queryByText(/^Cost/)).toBeNull();
    expect(screen.queryByText(/without price/)).toBeNull();
  });

  it('reads runs saved before metrics existed', () => {
    const run = makeRun({
      steps: {
        implement: step({
          durationMs: 1700,
          output: {
            status: 'success',
            model: 'litellm/claude-sonnet',
            usage: { inputTokens: 900, outputTokens: 100 },
          },
        }),
      },
    });
    renderInspector({ run, runLive: false, catalog: PRICED });
    const table = screen.getByRole('table', { name: 'Blocks in this run' });
    const implement = rowOf(table, /^implement/) as HTMLElement;
    expect(implement).toHaveTextContent('1.7 s');
    expect(implement).toHaveTextContent('1.0k');
    expect(rowOf(table, /^tests/)).toHaveClass('wf-run-river-item--quiet');
  });
});

describe('Trends', () => {
  it('shows averages per block over the last runs', () => {
    renderInspector({ run: makeRun(), runLive: false, catalog: PRICED, history: HISTORY });
    const table = screen.getByRole('table', { name: 'Average of the last 2 runs' });
    const implement = rowOf(table, /^implement/) as HTMLElement;
    expect(
      within(implement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['implement', '1 m 4 s', '3.1k', '']);
    expect(
      within(rowOf(table, /^review_loop/) as HTMLElement)
        .getAllByRole('cell')
        .at(-1),
    ).toHaveTextContent('×3');
    expect(rowOf(table, /^tests/)).toBeUndefined();
  });

  it('explains when there are not enough runs yet', () => {
    renderInspector({ run: makeRun(), runLive: false, catalog: PRICED, history: HISTORY.slice(0, 1) });
    expect(screen.getByText('Average of the last 20 runs')).toBeInTheDocument();
    expect(screen.getByText('Trends appear after two runs.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /^Average/ })).toBeNull();
  });
});

describe('Run output metrics', () => {
  it('shows time, tokens, turns, tool calls, model and cost of an agent block', () => {
    renderInspector({
      selection: 'implement',
      run: makeRun(),
      runLive: false,
      catalog: PRICED,
      history: HISTORY,
    });
    const list = screen.getByRole('group', { name: 'Time and tokens' }) as HTMLElement;
    const value = (term: string) =>
      within(list).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent;
    expect(value('Time')).toBe('4.2 s');
    expect(value('Tokens')).toBe('10k in2.0k out');
    expect(value('Turns')).toBe('4');
    expect(value('Tool calls')).toBe('6');
    expect(value('Model')).toBe('litellm/claude-sonnet');
    expect(value('Cost')).toBe('0.15');
    expect(screen.getByText('Last 2 runs: 1 m 4 s, 3.1k tokens on average')).toBeInTheDocument();
  });

  it('adds the average per execution for blocks that ran several times', () => {
    renderInspector({ selection: 'tests', run: makeRun(), runLive: false, catalog: PRICED });
    const list = screen.getByRole('group', { name: 'Time and tokens' });
    const time = within(list).getByText('Time', { selector: 'dt' }).nextElementSibling as HTMLElement;
    expect(within(time).getByText('3.6 s')).toBeInTheDocument();
    expect(within(time).getByText('1.2 s each')).toBeInTheDocument();
    expect(within(list).queryByText('Tokens')).toBeNull();
  });

  it('shows loop iterations in the trend line', () => {
    renderInspector({
      selection: 'review_loop',
      run: makeRun(),
      runLive: false,
      catalog: PRICED,
      history: HISTORY,
    });
    expect(screen.getByText('Last 2 runs: 1 m 0 s, 3 iterations on average')).toBeInTheDocument();
  });

  it('stays quiet while a block runs and for blocks without numbers', () => {
    const run = makeRun({ status: 'running', steps: { implement: step({ status: 'running' }) } });
    renderInspector({ selection: 'implement', run, runLive: true, catalog: PRICED });
    expect(screen.queryByRole('group', { name: 'Time and tokens' })).toBeNull();
  });
});
