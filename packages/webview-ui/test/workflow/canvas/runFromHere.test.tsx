import { fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  blockHashes,
  parseWorkflowText,
  type RunRecordSummary,
  type RunView,
  type StepRunView,
  type Workflow,
} from '@isar-flow/core';
import { card, clearPosted, docFor, host, posted, REVIEW_TEXT, renderEditor, stubLayout } from './helpers';

vi.mock('../../../src/views/workflow/inspector/Inspector', () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

beforeAll(stubLayout);

const QUICK = [
  'version: 1',
  'name: Quick',
  'steps:',
  '  - id: build',
  '    type: console',
  '    run: npm run build',
  '  - id: deploy',
  '    type: console',
  '    run: npm run deploy',
  '',
].join('\n');

const step = (
  status: StepRunView['status'],
  output: Record<string, unknown>,
  extra: Partial<StepRunView> = {},
) =>
  ({
    status,
    executions: 1,
    durationMs: 1000,
    startedAt: 1000,
    output: { status, ...output },
    logs: [],
    ...extra,
  }) as StepRunView;

function runOf(text: string, steps: Record<string, StepRunView>, overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-3',
    workflowName: 'Review until approved',
    status: 'failure',
    startedAt: Date.now() - 5 * 60_000,
    durationMs: 60_000,
    inputs: { task: 'Add vouchers' },
    usage: { inputTokens: 0, outputTokens: 0 },
    steps,
    blockHashes: blockHashes(parseWorkflowText(text).workflow as Workflow),
    ...overrides,
  };
}

/** run-3 of the review loop: the tests kept failing until the loop gave up. */
function failedReviewRun(overrides: Partial<RunView> = {}): RunView {
  return runOf(
    REVIEW_TEXT,
    {
      implement: step('success', { text: 'Added vouchers.' }),
      review_loop: step(
        'failure',
        { iterations: 5 },
        { loop: { iteration: 5, maxIterations: 5 }, error: 'Limit' },
      ),
      tests: step(
        'failure',
        { exitCode: 1, output: '1 failed' },
        { executions: 5, iteration: 5, startedAt: 9000 },
      ),
      review: step('success', { json: { approved: false, issues: [] } }, { executions: 5, iteration: 5 }),
      needs_fix: step('success', { branch: 'then', result: true }, { executions: 5, iteration: 5 }),
      fix: step('success', { text: 'Fixed.' }, { executions: 5, iteration: 5 }),
    },
    overrides,
  );
}

function quickRun(overrides: Partial<RunView> = {}): RunView {
  return runOf(
    QUICK,
    {
      build: step('success', { exitCode: 0, output: 'built' }),
      deploy: step('failure', { exitCode: 1, output: 'denied' }),
    },
    { inputs: {}, workflowName: 'Quick', ...overrides },
  );
}

function openBlockMenu(container: HTMLElement, id: string) {
  fireEvent.contextMenu(card(container, id), { clientX: 10, clientY: 10 });
  return within(screen.getByRole('menu', { name: 'Block actions' }));
}

const record = (overrides: Partial<RunRecordSummary>): RunRecordSummary => ({
  runId: 'run-3',
  workflowUri: 'file:///work/review-loop.workflow.yaml',
  workflowName: 'Review until approved',
  status: 'failure',
  startedAt: Date.now() - 2 * 86_400_000,
  durationMs: 61_000,
  ...overrides,
});

describe('run from here in the block menu', () => {
  it('comes first, separated from the other actions', () => {
    const { container } = renderEditor();
    host({ type: 'run', run: failedReviewRun(), live: false });
    const menu = openBlockMenu(container, 'tests');
    const items = menu.getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('Run from here');
    expect(items[0].querySelector('.codicon-run-below')).not.toBeNull();
    expect(items[0]).not.toHaveAttribute('aria-disabled');
    expect(items[0].nextElementSibling).toHaveAttribute('role', 'separator');
  });

  const disabled: [string, () => void, string][] = [
    ['no run is shown', () => undefined, 'Show a finished run to run from here.'],
    [
      'the run is still running',
      () => host({ type: 'run', run: failedReviewRun({ status: 'running' }), live: true }),
      'Wait until the run has finished.',
    ],
    [
      'the run was simulated',
      () => host({ type: 'run', run: failedReviewRun({ simulated: true }), live: false }),
      "Simulated runs can't be continued. Run the workflow first.",
    ],
  ];
  it.each(disabled)('is disabled with the reason when %s', (_name, show, reason) => {
    const { container } = renderEditor();
    show();
    const item = openBlockMenu(container, 'tests').getAllByRole('menuitem')[0];
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent(reason);
  });

  it('is disabled in restricted mode', () => {
    const { container } = renderEditor(undefined, { trusted: false });
    host({ type: 'run', run: failedReviewRun(), live: false });
    const item = openBlockMenu(container, 'tests').getAllByRole('menuitem')[0];
    expect(item).toHaveTextContent('Running is disabled until you trust this workspace.');
  });

  it('asks for the inputs of that run and posts the exact request', () => {
    const { container } = renderEditor();
    host({ type: 'run', run: failedReviewRun(), live: false });
    clearPosted();
    fireEvent.click(openBlockMenu(container, 'tests').getByRole('menuitem', { name: /Run from here/ }));
    const dialog = screen.getByRole('dialog', { name: 'Run from tests' });
    expect(within(dialog).getByRole('textbox')).toHaveValue('Add vouchers');
    expect(within(dialog).getByText('review_loop continues at iteration 5 of 5.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Check before running')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run from here' }));
    expect(posted()).toEqual([
      { type: 'runFromHere', runId: 'run-3', stepId: 'tests', inputs: { task: 'Add vouchers' } },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts at once when there are no inputs and nothing to check', () => {
    const { container } = renderEditor(docFor(QUICK));
    host({ type: 'run', run: quickRun(), live: false });
    clearPosted();
    fireEvent.click(openBlockMenu(container, 'deploy').getByRole('menuitem', { name: /Run from here/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posted()).toEqual([{ type: 'runFromHere', runId: 'run-3', stepId: 'deploy', inputs: {} }]);
  });

  it('asks first when a block before the target changed since that run', () => {
    const changed = QUICK.replace('npm run build', 'npm run build -- --prod');
    const { container } = renderEditor(docFor(changed));
    host({ type: 'run', run: quickRun(), live: false });
    clearPosted();
    fireEvent.click(openBlockMenu(container, 'deploy').getByRole('menuitem', { name: /Run from here/ }));
    const dialog = screen.getByRole('dialog', { name: 'Run from deploy' });
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'build changed since that run, so its result may be outdated.',
    );
    expect(posted()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The request is gone: showing the run again does not reopen the dialog.
    host({ type: 'run', run: quickRun(), live: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never starts behind an open dialog when the warning goes away', () => {
    const changed = QUICK.replace('npm run build', 'npm run build -- --prod');
    const { container } = renderEditor(docFor(changed));
    host({ type: 'run', run: quickRun(), live: false });
    clearPosted();
    fireEvent.click(openBlockMenu(container, 'deploy').getByRole('menuitem', { name: /Run from here/ }));
    expect(screen.getByRole('dialog', { name: 'Run from deploy' })).toBeInTheDocument();
    // The edit is undone in the YAML while the dialog is open: nothing is left to check.
    host({ type: 'document', doc: docFor(QUICK) });
    const dialog = screen.getByRole('dialog', { name: 'Run from deploy' });
    expect(within(dialog).queryByText('Check before running')).not.toBeInTheDocument();
    expect(
      within(dialog).getByText('Blocks before deploy reuse the results of the run from 5 min ago.'),
    ).toBeInTheDocument();
    expect(posted()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run from here' }));
    expect(posted()).toEqual([{ type: 'runFromHere', runId: 'run-3', stepId: 'deploy', inputs: {} }]);
  });
});

describe('run from here in the Runs menu', () => {
  const openRuns = () => {
    fireEvent.click(document.querySelector('.wf-runs') as HTMLElement);
    return within(screen.getByRole('menu', { name: 'Runs' }));
  };

  it('follows a failed or cancelled run with the block it stopped at', () => {
    renderEditor();
    host({
      type: 'history',
      runs: [
        record({ runId: 'run-7', status: 'success' }),
        record({ runId: 'run-5', status: 'cancelled', stoppedAt: 'review' }),
        record({ runId: 'run-4', status: 'failure', stoppedAt: 'tests', simulated: true }),
        record({ runId: 'run-3', status: 'failure', stoppedAt: 'tests' }),
        record({ runId: 'run-2', status: 'failure', stoppedAt: 'gone' }),
      ],
    });
    const items = openRuns().getAllByRole('menuitem');
    const labels = items.map((item) => item.querySelector('.if-menu__label')?.textContent);
    expect(labels.filter((l) => l?.startsWith('Run from'))).toEqual(['Run from review', 'Run from tests']);
    const runFromTests = items.find((item) => item.textContent?.includes('Run from tests'));
    expect(runFromTests?.className).toContain('if-menu__item--indent');
    expect(runFromTests?.querySelector('.codicon-run-below')).not.toBeNull();
  });

  it('shows that run and asks to run from its block', () => {
    renderEditor();
    host({ type: 'history', runs: [record({ stoppedAt: 'tests' })] });
    clearPosted();
    fireEvent.click(openRuns().getByRole('menuitem', { name: 'Run from tests' }));
    expect(posted()).toEqual([{ type: 'selectRun', runId: 'run-3' }]);
    host({ type: 'run', run: failedReviewRun(), live: false });
    expect(screen.getByRole('dialog', { name: 'Run from tests' })).toBeInTheDocument();
  });

  it('forgets the request when the run is gone', () => {
    renderEditor();
    host({ type: 'history', runs: [record({ stoppedAt: 'tests' })] });
    fireEvent.click(openRuns().getByRole('menuitem', { name: 'Run from tests' }));
    host({ type: 'run', run: null, live: false });
    host({ type: 'run', run: failedReviewRun(), live: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('marks simulated and resumed runs', () => {
    renderEditor();
    host({
      type: 'history',
      runs: [
        record({ runId: 'run-9', status: 'success', simulated: true }),
        record({ runId: 'run-8', status: 'success', resumedFrom: { runId: 'run-3', stepId: 'tests' } }),
      ],
    });
    const [simulated, resumed] = openRuns().getAllByRole('menuitem');
    expect(within(simulated).getByText('Simulated')).toHaveClass('if-chip');
    expect(within(resumed).getByText('Resumed')).toHaveAttribute('title', 'Resumed from tests');
  });

  it('marks the shown run on the Runs button', () => {
    renderEditor();
    host({ type: 'run', run: failedReviewRun({ status: 'success', simulated: true }), live: false });
    expect(
      within(document.querySelector('.wf-runs') as HTMLElement).getByText('Simulated'),
    ).toBeInTheDocument();
  });
});

describe('run markers on the canvas', () => {
  it('shows Simulated on the Start marker of a simulated run', () => {
    const { container } = renderEditor();
    host({ type: 'run', run: failedReviewRun({ status: 'success', simulated: true }), live: false });
    const start = container.querySelector('.wf-marker') as HTMLElement;
    expect(
      within(start).getByText('Simulated').closest('.if-chip')?.querySelector('.codicon-beaker'),
    ).not.toBeNull();
  });

  it('shows no time or cost on the cards of a simulated run', () => {
    const { container } = renderEditor();
    const run = failedReviewRun({ status: 'success', simulated: true });
    host({ type: 'run', run, live: false });
    expect(card(container, 'implement').querySelector('.wf-card__metrics')).toBeNull();
    host({ type: 'run', run: { ...run, simulated: false }, live: false });
    expect(card(container, 'implement').querySelector('.wf-card__metrics')).not.toBeNull();
  });

  it('shows where a resumed run started and marks reused blocks', () => {
    const { container } = renderEditor();
    const base = failedReviewRun();
    const run: RunView = {
      ...base,
      runId: 'run-9',
      status: 'success',
      resumedFrom: { runId: 'run-3', stepId: 'tests' },
      steps: {
        implement: { ...base.steps.implement, reused: true, durationMs: 0 },
        review_loop: step('success', { iterations: 5 }, { loop: { iteration: 5, maxIterations: 5 } }),
        tests: step('success', { exitCode: 0 }, { iteration: 5 }),
      },
    };
    host({ type: 'run', run, live: false });
    const start = container.querySelector('.wf-marker') as HTMLElement;
    const chip = within(start).getByText('Resumed from tests').closest('.if-chip') as HTMLElement;
    expect(chip.querySelector('.codicon-run-below')).not.toBeNull();
    const reused = within(card(container, 'implement'))
      .getByText('Reused')
      .closest('.if-chip') as HTMLElement;
    expect(reused).toHaveAttribute('title', 'Not run: the result comes from the run this one continues.');
    expect(reused.querySelector('.codicon-history')).not.toBeNull();
    expect(card(container, 'implement').querySelector('.wf-card__metrics')).toBeNull();
    expect(within(card(container, 'tests')).queryByText('Reused')).not.toBeInTheDocument();
  });
});
