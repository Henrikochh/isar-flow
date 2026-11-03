import { within } from '@testing-library/react';
import type { AgentSummary, ModelCatalog, RunView, StepRunView } from '@isar-flow/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CATALOG } from '../../../harness/fixtures';
import { card, docFor, host, renderEditor, REVIEW_TEXT, stubLayout } from './helpers';

vi.mock('../../../src/views/workflow/inspector/Inspector', () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

beforeAll(stubLayout);

const AGENTS: AgentSummary[] = [
  {
    id: 'coder',
    name: 'Coder',
    model: 'litellm/claude-sonnet',
    tools: ['readFile', 'editFile', 'applyPatch', 'runCommand'],
    permissions: { edits: 'auto', commands: 'ask' },
    scope: 'workspace',
    uri: 'file:///w/coder.agent.yaml',
    valid: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    model: 'vscode/copilot/gpt-4.1',
    tools: ['readFile', 'gitDiff'],
    permissions: { edits: 'none', commands: 'none' },
    scope: 'workspace',
    uri: 'file:///w/reviewer.agent.yaml',
    valid: true,
  },
];

const PRICED: ModelCatalog = { ...CATALOG, prices: { 'litellm/claude-sonnet': { input: 10, output: 25 } } };

function step(overrides: Partial<StepRunView>): StepRunView {
  return { status: 'success', executions: 1, logs: [], ...overrides };
}

function finishedRun(steps: Record<string, StepRunView>): RunView {
  return {
    runId: 'run-9',
    workflowName: 'Review until approved',
    status: 'success',
    startedAt: 1000,
    durationMs: 90_000,
    inputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    steps,
  };
}

const RUN = finishedRun({
  implement: step({
    durationMs: 4200,
    metrics: {
      durationMs: 4200,
      executions: 1,
      usage: { inputTokens: 3000, outputTokens: 400 },
      model: 'litellm/claude-sonnet',
      turns: 4,
      toolCalls: 6,
    },
  }),
  review_loop: step({
    durationMs: 61_000,
    loop: { iteration: 3, maxIterations: 5 },
    metrics: { durationMs: 61_000, executions: 1, iterations: 3 },
  }),
  tests: step({ status: 'failure', executions: 3, metrics: { durationMs: 3600, executions: 3 } }),
  review: step({
    executions: 3,
    metrics: {
      durationMs: 9000,
      executions: 3,
      usage: { inputTokens: 900, outputTokens: 100 },
      model: 'vscode/copilot/gpt-4.1',
      turns: 3,
      toolCalls: 2,
    },
  }),
  needs_fix: step({ executions: 3, metrics: { durationMs: 10, executions: 3 } }),
  fix: step({ status: 'skipped' }),
});

function render(run: RunView | null, catalog: ModelCatalog = PRICED) {
  const utils = renderEditor(docFor(REVIEW_TEXT));
  host({ type: 'catalog', agents: AGENTS, catalog });
  host({ type: 'run', run, live: false });
  return utils;
}

const metricsOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.wf-card__metrics');

describe('card metrics', () => {
  it('shows time, tokens and cost of a finished agent block, with details in the tooltip', () => {
    const { container } = render(RUN);
    const metrics = metricsOf(card(container, 'implement'));
    expect(metrics).not.toBeNull();
    const spans = Array.from(metrics?.children ?? []).map((el) => el.textContent);
    expect(spans).toEqual(['4.2 s', '3.4k tokens', 'Cost 0.04']);
    expect(metrics?.textContent).not.toContain('·');
    expect(metrics).toHaveAttribute('title', expect.stringContaining('4 turns'));
    expect(metrics?.getAttribute('title')).toContain('6 tool calls');
    expect(within(metrics as HTMLElement).getByText('Cost 0.04')).toHaveAttribute(
      'title',
      'Estimated from isarFlow.modelPrices',
    );
  });

  it('leaves the cost out for models without a price and names repeated executions', () => {
    const { container } = render(RUN);
    const review = metricsOf(card(container, 'review'));
    expect(review?.textContent).toContain('1.0k tokens');
    expect(review?.textContent).not.toContain('Cost');
    expect(review?.getAttribute('title')).toContain('Ran 3 times');
    expect(metricsOf(card(container, 'tests'))?.textContent).toBe('3.6 s');
  });

  it('has no metrics row before a block finished, for skipped blocks or without metrics', () => {
    const { container } = render(
      finishedRun({
        implement: step({ status: 'running', metrics: { durationMs: 10, executions: 1 } }),
        tests: step({ durationMs: 1200 }),
      }),
    );
    expect(metricsOf(card(container, 'implement'))).toBeNull();
    // Runs saved before metrics existed still show the time of the block.
    expect(metricsOf(card(container, 'tests'))?.textContent).toBe('1.2 s');
    expect(metricsOf(card(container, 'review'))).toBeNull();
  });

  it('shows the numbers of a block that ran before the last loop iteration skipped it', () => {
    const { container } = render(
      finishedRun({
        fix: step({
          status: 'skipped',
          metrics: { durationMs: 2500, executions: 1, usage: { inputTokens: 9000, outputTokens: 600 } },
        }),
      }),
    );
    const spans = Array.from(metricsOf(card(container, 'fix'))?.children ?? []).map((el) => el.textContent);
    expect(spans.slice(0, 2)).toEqual(['2.5 s', '9.6k tokens']);
  });

  it('shows nothing without a run', () => {
    const { container } = render(null);
    expect(container.querySelector('.wf-card__metrics')).toBeNull();
  });

  it('shows how often a loop ran in its header, also from metrics alone', () => {
    const { container, unmount } = render(RUN);
    const loop = container.querySelector<HTMLElement>('[aria-label="Loop review_loop"]');
    expect(loop).toHaveTextContent('Ran 3 times');
    unmount();
    const again = render(
      finishedRun({ review_loop: step({ metrics: { durationMs: 1, executions: 1, iterations: 2 } }) }),
    );
    expect(again.container.querySelector('[aria-label="Loop review_loop"]')).toHaveTextContent('Ran 2 times');
  });
});

describe('agent card capability badges', () => {
  it('shows what the referenced agent may do', () => {
    const { container } = render(null);
    const implement = card(container, 'implement');
    expect(implement).toHaveTextContent('Edits files (auto)');
    expect(implement).toHaveTextContent('Runs commands (asks)');
    expect(within(implement).getByText('Edits files (auto)').closest('.if-chip')).toHaveAttribute(
      'title',
      'Changes files without asking.',
    );
    expect(card(container, 'review')).toHaveTextContent('Read-only');
  });

  it('reads inline agent settings and skips unknown agents', () => {
    const text = `version: 1
name: W
steps:
  - id: inline
    type: agent
    agent: { model: litellm/gpt-4.1, tools: [readFile, writeFile], permissions: { edits: ask } }
    prompt: Do it
  - id: ghost
    type: agent
    agent: nobody
    prompt: Do it
`;
    const { container } = renderEditor(docFor(text));
    host({ type: 'catalog', agents: AGENTS, catalog: PRICED });
    expect(card(container, 'inline')).toHaveTextContent('Edits files (asks)');
    expect(card(container, 'ghost')).not.toHaveTextContent(/Read-only|Edits files|Runs commands/);
  });
});
