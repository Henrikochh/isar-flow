import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { statusText, statusTooltip, type TriggerListEntry } from '../../../src/triggers/statusBar';
import { vscodeTriggerUi } from '../../../src/triggers/ui';
import { createHarness, every, type Harness, onChange, onSave, summary, workflowUri } from './harness';

const LINT = workflowUri('lint');
const MINUTE = 60_000;

const entry = (name: string, state: TriggerListEntry['state']): TriggerListEntry => ({
  workflowUri: workflowUri(name.toLowerCase()),
  name,
  state,
});

describe('status bar text and tooltip', () => {
  const save = onSave('src/*.ts');
  const schedule = every('hour', 3_600_000);

  it('counts the active triggers', () => {
    expect(
      statusText([
        entry('Lint', { triggers: [save, schedule], status: 'active' }),
        entry('Docs', { triggers: [save], status: 'active' }),
        entry('Off', { triggers: [save], status: 'paused', pausedReason: 'approval' }),
      ]),
    ).toBe('$(zap) 3 triggers');
    expect(statusText([entry('Lint', { triggers: [save], status: 'active' })])).toBe('$(zap) 1 trigger');
  });

  it('says paused when no trigger is active', () => {
    expect(
      statusText([entry('Lint', { triggers: [save], status: 'paused', pausedReason: 'disabled' })]),
    ).toBe('$(zap) Triggers paused');
  });

  it('lists each workflow with its triggers and state, escaping user text', () => {
    const tooltip = statusTooltip(
      [
        entry('Lint *fast*', { triggers: [save, schedule], status: 'active', nextRunAt: 0 }),
        entry('Docs', {
          triggers: [onChange('docs/**')],
          status: 'paused',
          pausedReason: 'approval',
          pausedMessage: 'Run it once.',
        }),
        entry('Plain', { triggers: [save], status: 'active' }),
      ],
      () => '10:15',
    );
    expect(tooltip.value).toBe(
      [
        '**Isar Flow triggers**',
        '',
        '**Lint \\*fast\\***  ',
        'On save: src/\\*\\.ts  ',
        'Every hour  ',
        'Active, next run at 10:15',
        '',
        '**Docs**  ',
        'On change: docs/\\*\\*  ',
        'Paused: Run it once\\.',
        '',
        '**Plain**  ',
        'On save: src/\\*\\.ts  ',
        'Active',
      ].join('\n'),
    );
  });
});

describe('trigger service: status bar', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  it('is hidden without workflows with triggers', async () => {
    h = createHarness({ workflows: [summary('build', [])] });
    await h.settle();
    expect(h.item.visible).toBe(false);
    expect(h.item.command).toBe('isarFlow.showTriggers');
  });

  it('shows the active triggers and follows changes', async () => {
    h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts'), every('1h', 3_600_000)])] });
    await h.settle();
    expect(h.item).toMatchObject({ visible: true, text: '$(zap) 2 triggers' });
    expect((h.item.tooltip as vscode.MarkdownString).value).toContain('**Lint**');
    h.setEnabled(false);
    expect(h.item.text).toBe('$(zap) Triggers paused');
    h.setWorkflows([]);
    expect(h.item.visible).toBe(false);
  });

  describe('isarFlow.showTriggers', () => {
    const show = () => h.handlers.get('isarFlow.showTriggers')?.() as Promise<void>;

    it('says when no workflow has triggers', async () => {
      h = createHarness();
      await show();
      expect(h.ui.showInfo).toHaveBeenCalledWith(
        'No workflow has triggers yet. Add on: to a workflow to start it on save, on file changes or on a schedule.',
      );
    });

    it('lists the workflows with their state and opens the picked one', async () => {
      h = createHarness({
        workflows: [
          summary('lint', [onSave('src/*.ts'), every('1h', 3_600_000)]),
          summary('docs', [onChange('d/**')]),
        ],
        confirmation: 'approved',
      });
      await h.settle();
      h.runs.confirmationState.mockResolvedValue('needed');
      h.save(vscode.Uri.parse(workflowUri('docs')).fsPath);
      await h.settle();
      h.ui.showQuickPick
        .mockImplementationOnce(async (items: { label: string }[]) =>
          items.find((item) => item.label === 'Lint'),
        )
        .mockImplementationOnce(async (items: { label: string }[]) => items[0]);
      await show();
      const [items, options] = h.ui.showQuickPick.mock.calls[0];
      expect(options).toEqual({ placeHolder: 'Workflows with triggers' });
      expect(
        items.map(({ label, description, detail }: vscode.QuickPickItem) => ({ label, description, detail })),
      ).toEqual([
        {
          label: 'Docs',
          description: 'Paused',
          detail: "Run 'Docs' once and choose 'Run and remember' so its triggers can start it.",
        },
        { label: 'Lint', description: 'Active', detail: 'On save: src/*.ts, Every 1h' },
      ]);
      const [actions, actionOptions] = h.ui.showQuickPick.mock.calls[1];
      expect(actionOptions).toEqual({ placeHolder: 'Lint' });
      expect(actions.map((action: vscode.QuickPickItem) => action.label)).toEqual([
        '$(go-to-file) Open workflow',
        '$(settings-gear) Turn triggers off',
      ]);
      expect(h.ui.executeCommand).toHaveBeenCalledWith(
        'vscode.openWith',
        vscode.Uri.parse(LINT),
        'isarFlow.workflowEditor',
      );
    });

    it('offers to resume limited triggers', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
      await h.settle();
      for (let i = 0; i < 11; i++) {
        h.save('/ws/src/a.ts');
        await h.elapse(2_000);
        const runId = h.runs.active(LINT)[0]?.runId;
        if (runId) h.finish(runId);
        await h.elapse(3_000);
      }
      expect(h.service.state(LINT).pausedReason).toBe('limited');
      h.ui.showQuickPick
        .mockImplementationOnce(async (items: unknown[]) => items[0])
        .mockImplementationOnce(async (items: { label: string }[]) =>
          items.find((item) => item.label.endsWith('Resume triggers')),
        );
      await show();
      expect(h.service.state(LINT).status).toBe('active');
    });

    it('opens the setting', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])], enabled: false });
      await h.settle();
      h.ui.showQuickPick
        .mockImplementationOnce(async (items: unknown[]) => items[0])
        .mockImplementationOnce(async (items: { label: string }[]) => items[items.length - 1]);
      await show();
      expect(h.ui.showQuickPick.mock.calls[1][0].at(-1).label).toBe('$(settings-gear) Turn triggers on');
      expect(h.ui.executeCommand).toHaveBeenCalledWith(
        'workbench.action.openSettings',
        'isarFlow.triggers.enabled',
      );
    });

    it('does nothing when the QuickPick is closed', async () => {
      h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
      await h.settle();
      h.ui.showQuickPick.mockResolvedValueOnce(undefined);
      await show();
      h.ui.showQuickPick
        .mockImplementationOnce(async (items: unknown[]) => items[0])
        .mockResolvedValueOnce(undefined);
      await show();
      expect(h.ui.executeCommand).not.toHaveBeenCalled();
    });
  });
});

describe('trigger service: dispose', () => {
  it('stops watching, timers and the command, and hides the item', async () => {
    const h = createHarness({
      workflows: [summary('lint', [onSave('src/*.ts'), onChange('d/**'), every('1m', MINUTE)])],
    });
    await h.settle();
    h.save('/ws/src/a.ts');
    h.service.dispose();
    h.service.dispose();
    expect(h.watchers[0].disposed).toBe(true);
    expect(h.item.dispose).toHaveBeenCalled();
    expect(h.handlers.has('isarFlow.showTriggers')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    h.save('/ws/src/a.ts');
    await h.elapse(5 * MINUTE);
    expect(h.runs.start).not.toHaveBeenCalled();
    h.dispose();
  });

  it('drops a start that was still being checked', async () => {
    const h = createHarness({ workflows: [summary('lint', [onSave('src/*.ts')])] });
    await h.settle();
    let approve: (state: 'approved') => void = () => undefined;
    h.runs.confirmationState.mockImplementationOnce(() => new Promise((resolve) => (approve = resolve)));
    h.save('/ws/src/a.ts');
    await h.elapse(2_000);
    h.service.dispose();
    approve('approved');
    await h.settle();
    expect(h.runs.start).not.toHaveBeenCalled();
    h.dispose();
  });
});

describe('vscodeTriggerUi', () => {
  it('creates the status bar item on the left after the run item', () => {
    const create = vi.spyOn(vscode.window, 'createStatusBarItem');
    const item = vscodeTriggerUi.createStatusItem();
    expect(create).toHaveBeenCalledWith('isarFlow.triggers', vscode.StatusBarAlignment.Left, 9);
    expect(item.name).toBe('Isar Flow triggers');
    create.mockRestore();
  });
});
