import * as vscode from 'vscode';
import type { WorkflowTriggerState } from '@isar-flow/core';
import { WORKFLOW_EDITOR_VIEW_TYPE } from '../editors/host';
import { ENABLED_SETTING, SETTING_SECTION } from './state';
import { SHOW_TRIGGERS_COMMAND, type TriggerUi } from './ui';

export interface TriggerListEntry {
  workflowUri: string;
  name: string;
  state: WorkflowTriggerState;
}

/** What the status bar item and its QuickPick read and do. */
export interface TriggerListSource {
  list(): TriggerListEntry[];
  resume(workflowUri: string): void;
}

export interface TriggerStatusBar {
  /** Re-renders the item from `source.list()`. */
  update(): void;
  /** `isarFlow.showTriggers`: pick a workflow, then open it, resume its triggers or open the setting. */
  showTriggers(): Promise<void>;
  dispose(): void;
}

type Action = 'open' | 'resume' | 'setting';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const defaultFormatTime = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "$(zap) 3 triggers" (active triggers), "$(zap) Triggers paused" when none is active. */
export function statusText(list: readonly TriggerListEntry[]): string {
  const active = list
    .filter((entry) => entry.state.status === 'active')
    .reduce((count, entry) => count + entry.state.triggers.length, 0);
  return active > 0 ? `$(zap) ${plural(active, 'trigger')}` : '$(zap) Triggers paused';
}

/** Each workflow with its trigger labels and state. Names and labels are user text, so they are escaped. */
export function statusTooltip(
  list: readonly TriggerListEntry[],
  formatTime: (epochMs: number) => string = defaultFormatTime,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString('**Isar Flow triggers**');
  for (const { name, state } of list) {
    tooltip.appendMarkdown('\n\n**');
    tooltip.appendText(name);
    tooltip.appendMarkdown('**');
    for (const trigger of state.triggers) {
      tooltip.appendMarkdown('  \n');
      tooltip.appendText(trigger.label);
    }
    tooltip.appendMarkdown('  \n');
    if (state.status === 'paused') {
      tooltip.appendText(`Paused: ${state.pausedMessage ?? 'its triggers are paused.'}`);
    } else {
      tooltip.appendText(
        state.nextRunAt === undefined ? 'Active' : `Active, next run at ${formatTime(state.nextRunAt)}`,
      );
    }
  }
  return tooltip;
}

export function createTriggerStatusBar(
  source: TriggerListSource,
  ui: TriggerUi,
  enabled: () => boolean,
  formatTime?: (epochMs: number) => string,
): TriggerStatusBar {
  const item = ui.createStatusItem();
  item.command = SHOW_TRIGGERS_COMMAND;

  const pickAction = async (entry: TriggerListEntry): Promise<Action | undefined> => {
    const actions: (vscode.QuickPickItem & { action: Action })[] = [
      { label: '$(go-to-file) Open workflow', action: 'open' },
      ...(entry.state.pausedReason === 'limited'
        ? [{ label: '$(debug-continue) Resume triggers', action: 'resume' as const }]
        : []),
      {
        label: enabled() ? '$(settings-gear) Turn triggers off' : '$(settings-gear) Turn triggers on',
        description: 'Opens the setting for all workflows',
        action: 'setting',
      },
    ];
    return (await ui.showQuickPick(actions, { placeHolder: entry.name }))?.action;
  };

  return {
    update() {
      const list = source.list();
      if (list.length === 0) {
        item.hide();
        return;
      }
      item.text = statusText(list);
      item.tooltip = statusTooltip(list, formatTime);
      item.show();
    },

    async showTriggers() {
      const list = source.list();
      if (list.length === 0) {
        void ui.showInfo(
          'No workflow has triggers yet. Add on: to a workflow to start it on save, on file changes or on a schedule.',
        );
        return;
      }
      const items = list.map((entry) => ({
        label: entry.name,
        description: entry.state.status === 'active' ? 'Active' : 'Paused',
        detail:
          entry.state.status === 'paused'
            ? entry.state.pausedMessage
            : entry.state.triggers.map((trigger) => trigger.label).join(', '),
        entry,
      }));
      const picked = await ui.showQuickPick(items, { placeHolder: 'Workflows with triggers' });
      if (!picked) return;
      const { entry } = picked;
      switch (await pickAction(entry)) {
        case 'open':
          await ui.executeCommand(
            'vscode.openWith',
            vscode.Uri.parse(entry.workflowUri),
            WORKFLOW_EDITOR_VIEW_TYPE,
          );
          return;
        case 'resume':
          source.resume(entry.workflowUri);
          return;
        case 'setting':
          await ui.executeCommand('workbench.action.openSettings', `${SETTING_SECTION}.${ENABLED_SETTING}`);
          return;
      }
    },

    dispose() {
      item.dispose();
    },
  };
}
