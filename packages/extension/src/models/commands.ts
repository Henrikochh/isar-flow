import * as vscode from 'vscode';
import type { ModelRegistry } from '../contracts';
import {
  type CommandUi,
  createProviderCommands,
  type ProviderCommandDeps,
  type ProviderSettingsStore,
} from './providerCommands';
import { isRecord } from './settings';

/**
 * Registers the model endpoint commands. Commands that act on one endpoint take its id as the first
 * argument (the sidebar passes it) and ask with a quick pick otherwise.
 */
export function registerModelCommands(
  context: vscode.ExtensionContext,
  registry: ModelRegistry,
  overrides: Partial<ProviderCommandDeps> = {},
): vscode.Disposable {
  const commands = createProviderCommands({
    registry,
    secrets: context.secrets,
    settings: vscodeProviderSettings(),
    ui: vscodeCommandUi(),
    ...overrides,
  });
  const register = (id: string, handler: (providerId?: string) => Promise<void>) =>
    vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try {
        await handler(providerIdArg(arg));
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    });
  return vscode.Disposable.from(
    register('isarFlow.addProvider', () => commands.addProvider()),
    register('isarFlow.editProvider', (id) => commands.editProvider(id)),
    register('isarFlow.removeProvider', (id) => commands.removeProvider(id)),
    register('isarFlow.setProviderKey', (id) => commands.setProviderKey(id)),
    register('isarFlow.testProvider', (id) => commands.testProvider(id)),
    register('isarFlow.refreshModels', () => commands.refreshModels()),
  );
}

/** Accepts `'litellm'` or `{ providerId: 'litellm' }`; anything else (e.g. a menu's URI) means "ask". */
export function providerIdArg(arg: unknown): string | undefined {
  const value = isRecord(arg) ? (arg.providerId ?? arg.id) : arg;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Edits `isarFlow.providers` where it is defined: in the workspace settings when the workspace sets it
 * (that value wins), otherwise in the user settings.
 */
export function vscodeProviderSettings(): ProviderSettingsStore {
  const scope = () => {
    const config = vscode.workspace.getConfiguration('isarFlow');
    const inspected = config.inspect<unknown>('providers');
    const inWorkspace = inspected?.workspaceValue !== undefined;
    return {
      config,
      value: inWorkspace ? inspected?.workspaceValue : inspected?.globalValue,
      target: inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
    };
  };
  return {
    entries() {
      const { value } = scope();
      return Array.isArray(value) ? [...value] : [];
    },
    async save(entries) {
      const { config, target } = scope();
      await config.update('providers', entries, target);
    },
  };
}

export function vscodeCommandUi(): CommandUi {
  return {
    pick: async (items, options) =>
      vscode.window.showQuickPick(items, {
        title: options.title,
        placeHolder: options.placeHolder,
        matchOnDescription: true,
        ignoreFocusOut: true,
      }),
    input: async (options) =>
      vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        value: options.value,
        placeHolder: options.placeHolder,
        password: options.password,
        ignoreFocusOut: true,
        validateInput: options.validate,
      }),
    info: async (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    error: async (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
    confirm: async (message, detail, action) =>
      (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
    progress: async (title, task, options = {}) =>
      vscode.window.withProgress(
        {
          location: options.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
          title,
          cancellable: options.cancellable ?? false,
        },
        async (_progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            return await task(controller.signal);
          } finally {
            subscription.dispose();
          }
        },
      ),
    openSettings: (query) => void vscode.commands.executeCommand('workbench.action.openSettings', query),
  };
}
