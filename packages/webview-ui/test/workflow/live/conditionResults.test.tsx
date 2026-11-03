import { fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { card, host, renderEditor, stubLayout } from '../canvas/helpers';
import { fromHost, lastContext, renderInspector, shownRun } from './helpers';

beforeAll(stubLayout);

function loopHead(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-label="Loop review_loop"] .wf-loop__head') as HTMLElement;
}

describe('condition results on the canvas', () => {
  it('shows what the conditions were in the last run', () => {
    const { container } = renderEditor();
    expect(screen.queryByText(/^Last run:/)).toBeNull();

    host({ type: 'lastRunContext', context: lastContext() });
    const ifChip = within(card(container, 'needs_fix')).getByText('Last run: true');
    expect(ifChip).toHaveClass('if-chip--outline');
    expect(ifChip.querySelector('.codicon-pass')).not.toBeNull();
    // The until loop hit its limit: its condition was false.
    const loopChip = within(loopHead(container)).getByText('Last run: false');
    expect(loopChip.querySelector('.codicon-circle-slash')).not.toBeNull();
  });

  it('says Last simulation, in the simulation tone, when the last run was simulated', () => {
    const { container } = renderEditor();
    host({ type: 'lastRunContext', context: lastContext({ simulated: true }) });
    const ifChip = within(card(container, 'needs_fix')).getByText('Last simulation: true');
    expect(ifChip).toHaveClass('if-chip--simulated');
    expect(ifChip.querySelector('.codicon-pass')).not.toBeNull();
    expect(ifChip).toHaveAttribute('title', 'The condition was true when the last simulation checked it.');
    expect(screen.queryByText(/^Last run:/)).toBeNull();
  });

  it('shows nothing for conditions the last run did not check', () => {
    const { container } = renderEditor();
    const context = lastContext();
    delete context.steps.needs_fix;
    context.steps.review_loop = { status: 'cancelled' };
    host({ type: 'lastRunContext', context });
    expect(within(card(container, 'needs_fix')).queryByText(/^Last run:/)).toBeNull();
    expect(within(loopHead(container)).queryByText(/^Last run:/)).toBeNull();
  });

  it('leaves it to the lanes and iterations while a run is shown', () => {
    renderEditor();
    host({ type: 'lastRunContext', context: lastContext() });
    host({ type: 'run', run: shownRun(), live: false });
    expect(screen.queryByText(/^Last run:/)).toBeNull();
  });
});

describe('condition results in the condition builder', () => {
  it('appends the last run result to the summary', () => {
    renderInspector({ selection: 'needs_fix' });
    fromHost({ type: 'lastRunContext', context: lastContext() });
    const result = screen.getByText('Last run: true');
    expect(result).toHaveClass('wf-cond-live');
    expect(result.closest('.wf-cond-summary')).not.toBeNull();
  });

  it('names the shown run', () => {
    renderInspector({ selection: 'review_loop', run: shownRun() });
    // The run output opens first; the condition is in the settings.
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByText('This run: true')).toHaveClass('wf-cond-live');
  });

  it('names a simulation in the summary', () => {
    renderInspector({ selection: 'needs_fix' });
    fromHost({ type: 'lastRunContext', context: lastContext({ simulated: true }) });
    expect(screen.getByText('Last simulation: true')).toHaveClass('wf-cond-live');
  });

  it('shows no result when it is not known', () => {
    renderInspector({ selection: 'needs_fix' });
    expect(screen.queryByText(/run: (true|false)/)).toBeNull();
  });
});
