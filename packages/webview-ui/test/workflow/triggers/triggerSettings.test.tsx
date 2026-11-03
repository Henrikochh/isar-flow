import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWorkflowOps, parseWorkflowText, workflowTemplate } from '@isar-flow/core';
import { RELEASE_WORKFLOW_TEXT } from '../../../harness/fixtures';
import { docFor, renderInspector, resetPosted, sentOps } from '../inspector/helpers';

beforeEach(() => {
  resetPosted();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const settle = () => act(() => vi.advanceTimersByTime(400));
const open = (text = RELEASE_WORKFLOW_TEXT) => renderInspector({ doc: docFor(text) });
const section = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement;
const triggers = () => section('Triggers');
const toggle = (name: string) => within(triggers()).getByRole('switch', { name });
const patterns = (name: string) =>
  within(screen.getByRole('group', { name })).getAllByRole('textbox') as HTMLInputElement[];
/** The `on:` the sent ops leave in the release workflow. */
const onAfterOps = () =>
  parseWorkflowText(applyWorkflowOps(RELEASE_WORKFLOW_TEXT, sentOps()).text).workflow?.on;

describe('Triggers in the workflow settings', () => {
  it('shows the triggers of the workflow', () => {
    open();
    expect(
      within(triggers()).getByText(
        'Triggers run while VS Code is open, in trusted workspaces, after you ran the workflow once and chose Run and remember.',
      ),
    ).toBeInTheDocument();
    expect(toggle('Run on save')).toBeChecked();
    expect(patterns('Files to watch on save').map((input) => input.value)).toEqual([
      'src/**/*.ts',
      '!src/gen/**',
    ]);
    expect(toggle('Run when files change')).not.toBeChecked();
    expect(toggle('Run on a schedule')).toBeChecked();
    expect(screen.getByLabelText('Every')).toHaveValue('1h');
    expect(within(triggers()).getByText('Every hour')).toBeInTheDocument();
    expect(
      within(triggers()).getAllByText(
        'Relative to the workspace folder, e.g. src/**/*.ts. Start with ! to exclude.',
      ),
    ).toHaveLength(1);
  });

  it('adds a pattern to the save trigger', () => {
    open();
    fireEvent.click(within(triggers()).getAllByRole('button', { name: 'Add pattern' })[0]);
    fireEvent.change(patterns('Files to watch on save')[2], { target: { value: 'tests/**' } });
    settle();
    expect(onAfterOps()).toEqual({
      save: { files: ['src/**/*.ts', '!src/gen/**', 'tests/**'] },
      schedule: { every: '1h' },
    });
  });

  it('turns triggers off one by one and removes on: with the last one', () => {
    open();
    fireEvent.click(toggle('Run on save'));
    expect(sentOps()).toEqual([{ op: 'updateWorkflow', set: { on: { schedule: { every: '1h' } } } }]);
    fireEvent.click(toggle('Run on a schedule'));
    expect(sentOps()[1]).toEqual({ op: 'updateWorkflow', set: {}, unset: ['on'] });
    expect(onAfterOps()).toBeUndefined();
  });

  it('starts a change trigger with an empty pattern and writes it once one is typed', () => {
    open();
    fireEvent.click(toggle('Run when files change'));
    expect(sentOps()).toEqual([]);
    const [first] = patterns('Files to watch for changes');
    expect(first).toHaveFocus();
    fireEvent.change(first, { target: { value: 'docs/**' } });
    settle();
    expect(onAfterOps()).toEqual({
      save: { files: ['src/**/*.ts', '!src/gen/**'] },
      change: { files: ['docs/**'] },
      schedule: { every: '1h' },
    });
  });

  it('checks the schedule and offers presets', () => {
    open();
    const every = screen.getByLabelText('Every');
    fireEvent.change(every, { target: { value: '5x' } });
    settle();
    expect(screen.getByText('Use a duration like 15m, 1h or 1h30m.')).toBeInTheDocument();
    fireEvent.change(every, { target: { value: '30s' } });
    settle();
    expect(screen.getByText('Use 1m or more: schedules run at most once a minute.')).toBeInTheDocument();
    expect(sentOps()).toEqual([]);
    fireEvent.change(every, { target: { value: '15m' } });
    settle();
    expect(within(triggers()).getByText('Every 15 min')).toBeInTheDocument();
    fireEvent.click(within(triggers()).getByRole('button', { name: '1 day' }));
    expect(sentOps().map((op) => op.op === 'updateWorkflow' && op.set.on)).toEqual([
      { save: { files: ['src/**/*.ts', '!src/gen/**'] }, schedule: { every: '15m' } },
      { save: { files: ['src/**/*.ts', '!src/gen/**'] }, schedule: { every: '1d' } },
    ]);
  });

  it('draws the presets as buttons and presses the one in the field', () => {
    open();
    const presets = within(triggers()).getByRole('group', { name: 'Presets' });
    const buttons = within(presets).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['15 min', '1 hour', '1 day']);
    for (const button of buttons) expect(button).toHaveClass('if-btn--secondary');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });

  it('adds the first trigger to a workflow without on:', () => {
    open(workflowTemplate('review-loop', 'Review until approved'));
    expect(toggle('Run on a schedule')).not.toBeChecked();
    fireEvent.click(toggle('Run on a schedule'));
    expect(sentOps()).toEqual([]);
    expect(screen.getByLabelText('Every')).toHaveFocus();
    fireEvent.click(within(triggers()).getByRole('button', { name: '1 hour' }));
    expect(sentOps()).toEqual([{ op: 'updateWorkflow', set: { on: { schedule: { every: '1h' } } } }]);
  });
});

describe('Copilot in the workflow settings', () => {
  it('lets Copilot run the workflow or not', () => {
    open();
    const copilot = section('Copilot');
    const expose = within(copilot).getByRole('switch', { name: 'Let Copilot run this workflow' });
    expect(expose).toBeChecked();
    expect(
      within(copilot).getByText(
        'Copilot can list and run it with @isarflow and its tools. You still confirm its commands.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(expose);
    expect(sentOps()).toEqual([{ op: 'updateWorkflow', set: {}, unset: ['expose'] }]);
    fireEvent.click(expose);
    expect(sentOps()[1]).toEqual({ op: 'updateWorkflow', set: { expose: true } });
  });
});
