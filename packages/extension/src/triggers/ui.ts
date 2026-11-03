import * as vscode from 'vscode';
import { ENABLED_SETTING, SETTING_SECTION } from './state';

export const STATUS_ITEM_ID = 'isarFlow.triggers';
export const SHOW_TRIGGERS_COMMAND = 'isarFlow.showTriggers';

/** The part of vscode.StatusBarItem the trigger service uses. */
export interface TriggerStatusItem {
  text: string;
  tooltip?: string | vscode.MarkdownString;
  command?: string | vscode.Command;
  name?: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** Window access of the trigger service, injectable for tests. */
export interface TriggerUi {
  showInfo(message: string, ...buttons: string[]): Thenable<string | undefined>;
  showWarning(message: string, ...buttons: string[]): Thenable<string | undefined>;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  createStatusItem(): TriggerStatusItem;
}

export interface TriggerSettings {
  /** `isarFlow.triggers.enabled`, read each time a trigger fires. */
  enabled(): boolean;
}

export interface TriggerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TriggerServiceOptions {
  /** Default Date.now. */
  now?: () => number;
  timers?: TriggerTimers;
  ui?: Partial<TriggerUi>;
  settings?: TriggerSettings;
}

type Handle = ReturnType<typeof setTimeout>;

// Wrappers, so fake timers installed after the service was created are used too.
export const systemTimers: TriggerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as Handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as Handle),
};

export const vscodeTriggerSettings: TriggerSettings = {
  enabled: () =>
    vscode.workspace.getConfiguration(SETTING_SECTION).get<boolean>(ENABLED_SETTING, true) !== false,
};

export const vscodeTriggerUi: TriggerUi = {
  showInfo: (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons),
  showWarning: (message, ...buttons) => vscode.window.showWarningMessage(message, ...buttons),
  showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
  executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  createStatusItem: () => {
    const item = vscode.window.createStatusBarItem(STATUS_ITEM_ID, vscode.StatusBarAlignment.Left, 9);
    item.name = 'Isar Flow triggers';
    return item;
  },
};
