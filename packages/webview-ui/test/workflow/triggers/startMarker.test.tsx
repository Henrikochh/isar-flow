import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunView, TriggerSummary, WorkflowTriggerState } from '@isar-flow/core';
import { RELEASE_WORKFLOW_TEXT } from '../../../harness/fixtures';
import { clearPosted, docFor, host, posted, renderEditor, stubLayout } from '../canvas/helpers';

vi.mock('../../../src/views/workflow/inspector/Inspector', () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

beforeAll(stubLayout);
afterEach(() => vi.useRealTimers());

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const SAVE: TriggerSummary = {
  kind: 'save',
  label: 'On save: src/**/*.ts, !src/gen/**',
  files: ['src/**/*.ts', '!src/gen/**'],
};
const SCHEDULE: TriggerSummary = { kind: 'schedule', label: 'Every hour', every: '1h', everyMs: 3_600_000 };

function show(triggers: Partial<WorkflowTriggerState>) {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  renderEditor(docFor(RELEASE_WORKFLOW_TEXT));
  host({ type: 'triggers', triggers: { triggers: [SAVE, SCHEDULE], status: 'active', ...triggers } });
  return screen.getByRole('group', { name: 'Triggers' });
}

describe('triggers on the Start marker', () => {
  it('shows a chip per trigger and when the schedule runs next', () => {
    const triggers = show({ nextRunAt: NOW + 12 * MINUTE });
    const save = within(triggers).getByText('On save: src/**/*.ts, !src/gen/**');
    expect(save.closest('.if-chip')?.querySelector('.codicon')).toHaveClass('codicon-save');
    expect(save.closest('.if-chip')).toHaveAttribute(
      'title',
      'Runs when you save a file matching src/**/*.ts, except src/gen/**',
    );
    const every = within(triggers).getByText('Every hour');
    expect(every.closest('.if-chip')?.querySelector('.codicon')).toHaveClass('codicon-watch');
    expect(within(triggers).getByText('Next run in 12 min')).toHaveClass('wf-marker__status');
  });

  it('says what the last trigger started', () => {
    const triggers = show({
      lastFired: { at: NOW - 3 * MINUTE, kind: 'save', file: 'src/app.ts', runId: 'r' },
    });
    expect(within(triggers).getByText('Last started on save of src/app.ts 3 min ago')).toBeInTheDocument();
  });

  it('says why the last trigger was skipped', () => {
    const triggers = show({
      lastFired: {
        at: NOW - 3 * MINUTE,
        kind: 'change',
        file: 'docs/a.md',
        skipped: 'The workflow was already running.',
      },
    });
    expect(
      within(triggers).getByText(
        'Not started by a change to docs/a.md 3 min ago. The workflow was already running.',
      ),
    ).toBeInTheDocument();
  });

  it('offers Run once while the commands wait for approval', () => {
    const message = 'Run the workflow once to approve its commands; then its triggers start it.';
    const triggers = show({ status: 'paused', pausedReason: 'approval', pausedMessage: message });
    expect(within(triggers).getByText('Triggers paused')).toHaveClass('if-chip');
    expect(within(triggers).getByText(message)).toBeInTheDocument();
    clearPosted();
    fireEvent.click(within(triggers).getByRole('button', { name: 'Run once' }));
    expect(posted()).toEqual([{ type: 'run', inputs: {} }]);
  });

  it('resumes triggers that were paused for starting too often', () => {
    const triggers = show({
      status: 'paused',
      pausedReason: 'limited',
      pausedMessage: 'Paused: too many runs.',
    });
    clearPosted();
    fireEvent.click(within(triggers).getByRole('button', { name: 'Resume' }));
    expect(posted()).toEqual([{ type: 'resumeTriggers' }]);
  });

  it('opens the setting that turned triggers off', () => {
    const triggers = show({ status: 'paused', pausedReason: 'disabled', pausedMessage: 'Triggers are off.' });
    clearPosted();
    fireEvent.click(within(triggers).getByRole('button', { name: 'Open settings' }));
    expect(posted()).toEqual([{ type: 'openSettings', query: 'isarFlow.triggers.enabled' }]);
  });

  it('offers nothing it cannot fix here', () => {
    const triggers = show({
      status: 'paused',
      pausedReason: 'untrusted',
      pausedMessage: 'Trust the workspace.',
    });
    expect(within(triggers).queryByRole('button')).toBeNull();
    expect(within(triggers).queryByText('Next run in 12 min')).toBeNull();
  });

  it('shows nothing without triggers', () => {
    renderEditor(docFor(RELEASE_WORKFLOW_TEXT));
    host({ type: 'triggers', triggers: { triggers: [], status: 'active' } });
    expect(screen.queryByRole('group', { name: 'Triggers' })).toBeNull();
  });

  it('shows how the shown run started', () => {
    renderEditor(docFor(RELEASE_WORKFLOW_TEXT));
    const run: RunView = {
      runId: 'run-12',
      workflowName: 'Release',
      status: 'success',
      startedAt: Date.now() - MINUTE,
      durationMs: 30_000,
      inputs: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: {},
      origin: { kind: 'trigger', trigger: 'save', file: 'src/app.ts' },
    };
    host({ type: 'run', run, live: false });
    host({ type: 'triggers', triggers: { triggers: [SAVE], status: 'active' } });
    const marker = document.querySelector('.wf-marker') as HTMLElement;
    const origin = within(marker).getByText('On save');
    expect(origin).toHaveAttribute('title', 'Started on save of src/app.ts');
    // The run's own chip is toned like 'Resumed from …', so it does not read as one more trigger.
    expect(origin).toHaveClass('if-chip--isar');
    const trigger = within(marker).getByText('On save: src/**/*.ts, !src/gen/**');
    expect(trigger.closest('.if-chip')).toHaveClass('if-chip--outline');
  });
});
