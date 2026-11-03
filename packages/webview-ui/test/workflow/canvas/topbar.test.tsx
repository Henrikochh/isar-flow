import { fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { reduceRunEvent, type RunEvent, type RunView } from '@isar-flow/core';
import { RECENT_RUNS } from '../../../harness/fixtures';
import { runBlocker } from '../../../src/views/workflow/topbar/TopBar';
import { card, clearPosted, docFor, host, posted, postedOps, renderEditor, stubLayout } from './helpers';

vi.mock('../../../src/views/workflow/inspector/Inspector', () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

beforeAll(stubLayout);

describe('runBlocker', () => {
  it('explains why the workflow cannot run', () => {
    expect(runBlocker(false, true, true, 0, 3)).toBe('Running is disabled until you trust this workspace.');
    expect(runBlocker(true, false, true, 2, 3)).toBe('Fix the 2 problems before running.');
    expect(runBlocker(true, true, true, 0, 0)).toBe('Add a block before running.');
    expect(runBlocker(true, true, true, 0, 3)).toBeNull();
  });
});

describe('top bar', () => {
  it('renames the workflow inline', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Review until approved' }));
    const input = screen.getByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(input, { target: { value: 'Ship it' } });
    clearPosted();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(postedOps()).toEqual([{ op: 'updateWorkflow', set: { name: 'Ship it' } }]);
  });

  it('asks for inputs before running and remembers them', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const dialog = screen.getByRole('dialog', { name: 'Run Review until approved' });
    const runButton = within(dialog).getByRole('button', { name: 'Run workflow' });
    expect(runButton).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Add vouchers' } });
    clearPosted();
    fireEvent.click(runButton);
    expect(posted()).toEqual([{ type: 'run', inputs: { task: 'Add vouchers' } }]);
  });

  it('runs a workflow without inputs directly', () => {
    renderEditor(
      docFor('version: 1\nname: Quick\nsteps:\n  - id: hello\n    type: console\n    run: echo hi\n'),
    );
    clearPosted();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(posted()).toEqual([{ type: 'run', inputs: {} }]);
  });

  it('disables Run in restricted mode and says why', () => {
    renderEditor(undefined, { trusted: false });
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getAllByText('Running is disabled until you trust this workspace.').length).toBeGreaterThan(
      0,
    );
  });

  it('says in Restricted Mode that the workflow can still be simulated', () => {
    renderEditor(undefined, { trusted: false });
    expect(
      screen.getByText(
        'Running is disabled until you trust this workspace. You can still simulate the workflow.',
      ),
    ).toBeInTheDocument();
  });

  it('simulates from the Restricted Mode banner, asking for the inputs first', () => {
    renderEditor(undefined, { trusted: false });
    const banner = screen
      .getByText('Running is disabled until you trust this workspace. You can still simulate the workflow.')
      .closest('.if-banner') as HTMLElement;
    fireEvent.click(within(banner).getByRole('button', { name: 'Simulate' }));
    const dialog = screen.getByRole('dialog', { name: 'Simulate Review until approved' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Try it' } });
    clearPosted();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simulate' }));
    expect(posted()).toEqual([{ type: 'simulate', inputs: { task: 'Try it' } }]);
  });

  it('offers no Simulate in the banner when the workflow cannot run', () => {
    renderEditor(docFor('version: 1\nname: Empty\nsteps: []\n'), { trusted: false });
    const banner = screen
      .getByText('Running is disabled until you trust this workspace. You can still simulate the workflow.')
      .closest('.if-banner') as HTMLElement;
    expect(within(banner).queryByRole('button', { name: 'Simulate' })).toBeNull();
  });

  it('lists problems and jumps to the block', () => {
    const text = 'version: 1\nname: W\nsteps:\n  - id: a\n    type: agent\n    promt: hi\n';
    const { container } = renderEditor(docFor(text));
    fireEvent.click(screen.getByRole('button', { name: /2 problems/ }));
    const menu = screen.getByRole('menu', { name: 'Problems' });
    fireEvent.click(within(menu).getAllByRole('menuitem')[0]);
    expect(card(container, 'a')).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches between runs from the history', () => {
    renderEditor();
    host({ type: 'history', runs: RECENT_RUNS });
    fireEvent.click(screen.getByRole('button', { name: /Runs/ }));
    clearPosted();
    fireEvent.click(within(screen.getByRole('menu', { name: 'Runs' })).getAllByRole('menuitem')[0]);
    expect(posted()).toEqual([{ type: 'selectRun', runId: 'run-7' }]);
  });

  it('says which past runs have files to review and what was decided', () => {
    renderEditor();
    const decided = {
      ...RECENT_RUNS[2],
      runId: 'run-4',
      review: { total: 4, kept: 3, reverted: 1, pending: 0 },
    };
    host({ type: 'history', runs: [RECENT_RUNS[0], decided, RECENT_RUNS[2]] });
    fireEvent.click(screen.getByRole('button', { name: /Runs/ }));
    const [toReview, done, plain] = within(screen.getByRole('menu', { name: 'Runs' })).getAllByRole(
      'menuitem',
    );
    expect(within(toReview).getByText('2 to review')).toHaveClass('if-chip--warning');
    expect(within(done).getByText('3 kept, 1 reverted')).toBeInTheDocument();
    expect(plain).not.toHaveTextContent(/to review|kept|reverted/);
  });

  it('shows Stop and the elapsed time during a live run', () => {
    renderEditor();
    const events: RunEvent[] = [
      { type: 'run-start', runId: 'r', workflowName: 'w', startedAt: 1000, inputs: {} },
      { type: 'step-start', runId: 'r', stepId: 'implement', stepType: 'agent', at: 1000 },
      {
        type: 'step-end',
        runId: 'r',
        stepId: 'implement',
        status: 'success',
        output: { status: 'success' },
        durationMs: 5000,
        at: 6000,
      },
      { type: 'step-start', runId: 'r', stepId: 'review_loop', stepType: 'loop', at: 6000 },
      { type: 'loop-iteration', runId: 'r', stepId: 'review_loop', iteration: 2, maxIterations: 5 },
    ];
    for (const event of events) host({ type: 'runEvent', event });
    expect(screen.getByRole('timer', { name: 'Elapsed time' })).toHaveTextContent(/^5\.\d s$/);
    expect(screen.getByText('Iteration 2 of 5')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Succeeded' }).length).toBeGreaterThan(0);
    clearPosted();
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Stop' }));
    expect(posted()).toEqual([{ type: 'cancelRun' }]);
  });
});

describe('banners', () => {
  it('answers a pending approval with a comment', () => {
    const { container } = renderEditor();
    const run = [
      { type: 'run-start', runId: 'r', workflowName: 'w', startedAt: 0, inputs: {} },
      { type: 'step-start', runId: 'r', stepId: 'implement', stepType: 'agent', at: 1 },
    ].reduce<RunView | null>((v, e) => reduceRunEvent(v, e as RunEvent), null);
    host({ type: 'run', run, live: true });
    host({
      type: 'approvalRequest',
      prompt: { requestId: 'q1', runId: 'r', stepId: 'implement', message: 'Merge it?' },
    });
    expect(screen.getByText('Approval needed')).toBeInTheDocument();
    expect(card(container, 'implement').className).toContain('wf-card--awaiting');
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Looks good' } });
    clearPosted();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(posted()).toEqual([{ type: 'approval', requestId: 'q1', approved: true, comment: 'Looks good' }]);
    host({ type: 'approvalResolved', requestId: 'q1' });
    expect(screen.queryByText('Approval needed')).not.toBeInTheDocument();
  });

  it('shows a failed edit until it is dismissed', () => {
    renderEditor();
    host({ type: 'opsFailed', error: 'Cannot move a block into itself' });
    expect(screen.getByText('The change could not be applied')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('The change could not be applied')).not.toBeInTheDocument();
  });
});

describe('run options', () => {
  const QUICK = 'version: 1\nname: Quick\nsteps:\n  - id: hello\n    type: console\n    run: echo hi\n';
  const openOptions = () => fireEvent.click(screen.getByRole('button', { name: 'More run options' }));
  const options = () => within(screen.getByRole('menu', { name: 'Run options' }));

  it('lists Run, Simulate and Edit simulation mocks', () => {
    renderEditor();
    openOptions();
    expect(
      options()
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Run', 'SimulateUse mocks; nothing runs', 'Edit simulation mocks']);
  });

  it('simulates a workflow without inputs at once', () => {
    renderEditor(docFor(QUICK));
    openOptions();
    clearPosted();
    fireEvent.click(options().getByRole('menuitem', { name: /Simulate/ }));
    expect(posted()).toEqual([{ type: 'simulate', inputs: {} }]);
  });

  it('asks for the inputs before simulating', () => {
    renderEditor();
    openOptions();
    fireEvent.click(options().getByRole('menuitem', { name: /Simulate/ }));
    const dialog = screen.getByRole('dialog', { name: 'Simulate Review until approved' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Try vouchers' } });
    clearPosted();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simulate' }));
    expect(posted()).toEqual([{ type: 'simulate', inputs: { task: 'Try vouchers' } }]);
  });

  it('runs from the menu like the Run button', () => {
    renderEditor(docFor(QUICK));
    openOptions();
    clearPosted();
    fireEvent.click(options().getByRole('menuitem', { name: 'Run' }));
    expect(posted()).toEqual([{ type: 'run', inputs: {} }]);
  });

  it('opens the simulation file', () => {
    renderEditor();
    openOptions();
    clearPosted();
    fireEvent.click(options().getByRole('menuitem', { name: 'Edit simulation mocks' }));
    expect(posted()).toEqual([{ type: 'openSimulationFile' }]);
  });

  it('keeps Simulate available in restricted mode', () => {
    renderEditor(docFor(QUICK), { trusted: false });
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    openOptions();
    expect(options().getByRole('menuitem', { name: /^Run/ })).toHaveAttribute('aria-disabled', 'true');
    clearPosted();
    fireEvent.click(options().getByRole('menuitem', { name: /Simulate/ }));
    expect(posted()).toEqual([{ type: 'simulate', inputs: {} }]);
  });

  it('turns off Simulate too when the workflow cannot run', () => {
    renderEditor(docFor('version: 1\nname: Empty\nsteps: []\n'));
    expect(screen.getByRole('button', { name: 'More run options' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More run options' })).toHaveAccessibleDescription(
      'Add a block before running.',
    );
  });

  it('keeps the keyboard focus in the run controls when Run turns into Stop and back', () => {
    renderEditor(docFor(QUICK));
    const run = screen.getByRole('button', { name: 'Run' });
    run.focus();
    fireEvent.click(run);
    host({
      type: 'runEvent',
      event: { type: 'run-start', runId: 'r', workflowName: 'Quick', startedAt: 0, inputs: {} },
    });
    const stop = within(screen.getByRole('banner')).getByRole('button', { name: 'Stop' });
    expect(stop).toHaveFocus();
    host({
      type: 'runEvent',
      event: {
        type: 'run-end',
        runId: 'r',
        status: 'success',
        durationMs: 10,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    expect(screen.getByRole('button', { name: 'Run' })).toHaveFocus();
  });

  it('moves the focus from Simulate to Stop when the simulation starts', () => {
    renderEditor(docFor(QUICK), { trusted: false });
    const more = screen.getByRole('button', { name: 'More run options' });
    more.focus();
    fireEvent.click(more);
    fireEvent.click(options().getByRole('menuitem', { name: /Simulate/ }));
    host({
      type: 'runEvent',
      event: {
        type: 'run-start',
        runId: 's',
        workflowName: 'Quick',
        startedAt: 0,
        inputs: {},
        simulated: true,
      },
    });
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Stop' })).toHaveFocus();
    host({
      type: 'runEvent',
      event: {
        type: 'run-end',
        runId: 's',
        status: 'success',
        durationMs: 10,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    // Run is off in Restricted Mode: the focus goes back to the run options.
    expect(screen.getByRole('button', { name: 'More run options' })).toHaveFocus();
  });

  it('leaves the focus alone when it is elsewhere as a run starts', () => {
    renderEditor(docFor(QUICK));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const yaml = screen.getByRole('button', { name: 'Open YAML' });
    yaml.focus();
    host({
      type: 'runEvent',
      event: { type: 'run-start', runId: 'r', workflowName: 'Quick', startedAt: 0, inputs: {} },
    });
    expect(yaml).toHaveFocus();
  });

  it('shows Stop instead while a simulated run is live', () => {
    renderEditor();
    host({
      type: 'runEvent',
      event: { type: 'run-start', runId: 's', workflowName: 'w', startedAt: 0, inputs: {}, simulated: true },
    });
    expect(screen.queryByRole('button', { name: 'More run options' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });
});
