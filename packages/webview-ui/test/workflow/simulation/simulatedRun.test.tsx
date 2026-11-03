/** A simulated run never reads as a real one: banner over the canvas, simulation-toned chips, its own dialog. */
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { blockHashes, type RunView, type StepRunView, type Workflow } from '@isar-flow/core';
import {
  clearPosted,
  docFor,
  host,
  posted,
  REVIEW_TEXT,
  renderEditor,
  reviewWorkflow,
  stubLayout,
} from '../canvas/helpers';

vi.mock('../../../src/views/workflow/inspector/Inspector', () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

beforeAll(stubLayout);

const step = (status: StepRunView['status'], output: Record<string, unknown>) =>
  ({
    status,
    executions: 1,
    durationMs: 400,
    startedAt: 1000,
    output: { status, ...output },
    logs: [],
  }) as StepRunView;

function simulatedRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-9',
    workflowName: 'Review until approved',
    status: 'success',
    startedAt: Date.now() - 60_000,
    durationMs: 8_000,
    inputs: { task: 'Add vouchers' },
    usage: { inputTokens: 0, outputTokens: 0 },
    blockHashes: blockHashes(reviewWorkflow() as Workflow),
    steps: { implement: step('success', { text: '(simulated answer)' }) },
    simulated: true,
    ...overrides,
  };
}

const banner = () => screen.queryByRole('status', { name: /^Simulat/ });

describe('the simulated run banner', () => {
  it('is pinned over the canvas while a simulated run is shown', () => {
    renderEditor();
    host({ type: 'run', run: simulatedRun(), live: false });
    const pinned = banner() as HTMLElement;
    expect(pinned).toHaveAccessibleName('Simulated run');
    expect(pinned).toHaveTextContent('Nothing was executed. Results come from the simulation file.');
    expect(pinned.querySelector('.codicon-beaker')).not.toBeNull();
    expect(pinned).toHaveClass('if-banner--simulated');
  });

  it('says that nothing is executed while the simulation runs', () => {
    renderEditor();
    host({
      type: 'runEvent',
      event: { type: 'run-start', runId: 's', workflowName: 'w', startedAt: 0, inputs: {}, simulated: true },
    });
    const pinned = banner() as HTMLElement;
    expect(pinned).toHaveAccessibleName('Simulating');
    expect(pinned).toHaveTextContent('Nothing is executed. Blocks return the mocks of the simulation file.');
  });

  it('opens the simulation file from Edit mocks', () => {
    renderEditor();
    host({ type: 'run', run: simulatedRun(), live: false });
    clearPosted();
    fireEvent.click(within(banner() as HTMLElement).getByRole('button', { name: 'Edit mocks' }));
    expect(posted()).toEqual([{ type: 'openSimulationFile' }]);
  });

  it('is not shown for a real run, and goes away when the shown run is real again', () => {
    renderEditor();
    host({ type: 'run', run: simulatedRun({ simulated: false }), live: false });
    expect(banner()).toBeNull();
    host({ type: 'run', run: simulatedRun(), live: false });
    expect(banner()).not.toBeNull();
    host({ type: 'run', run: null, live: false });
    expect(banner()).toBeNull();
  });
});

describe('simulation-toned chips', () => {
  it('marks the Start marker and the Runs button in the simulation tone', () => {
    const { container } = renderEditor();
    host({ type: 'run', run: simulatedRun(), live: false });
    const start = container.querySelector('.wf-marker') as HTMLElement;
    expect(within(start).getByText('Simulated')).toHaveClass('if-chip--simulated');
    const runs = container.querySelector('.wf-runs') as HTMLElement;
    expect(within(runs).getByText('Simulated')).toHaveClass('if-chip--simulated');
  });

  it('keeps resumed runs quiet: they ran for real', () => {
    const { container } = renderEditor();
    host({
      type: 'run',
      run: simulatedRun({ simulated: false, resumedFrom: { runId: 'run-3', stepId: 'tests' } }),
      live: false,
    });
    const runs = container.querySelector('.wf-runs') as HTMLElement;
    expect(within(runs).getByText('Resumed')).toHaveClass('if-chip--outline');
  });
});

describe('the Simulate dialog', () => {
  it('confirms with a button that does not look like Run', () => {
    renderEditor(docFor(REVIEW_TEXT));
    fireEvent.click(screen.getByRole('button', { name: 'More run options' }));
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Run options' })).getByRole('menuitem', { name: /Simulate/ }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Simulate Review until approved' });
    const confirm = within(dialog).getByRole('button', { name: 'Simulate' });
    expect(confirm).not.toHaveClass('if-btn--run');
    expect(confirm).toHaveClass('if-btn--simulate');
    expect(dialog.querySelector('.wf-dialog-dot')).toHaveClass('wf-dialog-dot--simulate');
  });

  it('keeps Run workflow as the run button of the Run dialog', () => {
    renderEditor(docFor(REVIEW_TEXT));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const dialog = screen.getByRole('dialog', { name: 'Run Review until approved' });
    expect(within(dialog).getByRole('button', { name: 'Run workflow' })).toHaveClass('if-btn--run');
    expect(dialog.querySelector('.wf-dialog-dot')).not.toHaveClass('wf-dialog-dot--simulate');
  });
});
