import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import pkg from '../../../package.json';
import { providerIdArg, registerModelCommands, vscodeProviderSettings } from '../../../src/models/commands';
import type { CommandUi } from '../../../src/models/providerCommands';
import type { ModelRegistry } from '../../../src/contracts';

afterEach(() => vi.restoreAllMocks());

function fakeConfig(values: { workspaceValue?: unknown; globalValue?: unknown }) {
  const update = vi.fn(
    async (_key: string, _value: unknown, _target?: vscode.ConfigurationTarget) => undefined,
  );
  const config = {
    get: () => undefined,
    has: () => true,
    inspect: () => ({ key: 'isarFlow.providers', ...values }),
    update,
  } as unknown as vscode.WorkspaceConfiguration;
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(config);
  return update;
}

describe('registerModelCommands', () => {
  it('registers the contributed model commands and disposes them', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const disposed: string[] = [];
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      handlers.set(id, handler);
      return new vscode.Disposable(() => disposed.push(id));
    });
    const confirm = vi.fn(async () => false);
    const ui = { confirm, error: vi.fn(async () => undefined) } as unknown as CommandUi;
    const settings = { entries: () => [{ id: 'litellm', baseUrl: 'http://a' }], save: vi.fn() };
    const context = { secrets: {} } as unknown as vscode.ExtensionContext;
    const registry = {} as ModelRegistry;

    const disposable = registerModelCommands(context, registry, { ui, settings });

    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    const ids = [...handlers.keys()];
    expect(ids).toEqual([
      'isarFlow.addProvider',
      'isarFlow.editProvider',
      'isarFlow.removeProvider',
      'isarFlow.setProviderKey',
      'isarFlow.testProvider',
      'isarFlow.refreshModels',
    ]);
    for (const id of ids) expect(contributed.has(id)).toBe(true);

    await handlers.get('isarFlow.removeProvider')?.({ providerId: 'litellm' });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('litellm'), expect.any(String), 'Remove');

    disposable.dispose();
    expect(disposed).toEqual(ids);
  });

  it('shows unexpected failures instead of throwing', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      handlers.set(id, handler);
      return new vscode.Disposable(() => undefined);
    });
    const shown = vi.fn(async (_message: string) => undefined);
    vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(shown);
    const ui = {
      progress: async () => Promise.reject(new Error('Settings are read-only.')),
    } as unknown as CommandUi;
    registerModelCommands({ secrets: {} } as unknown as vscode.ExtensionContext, {} as ModelRegistry, { ui });

    await handlers.get('isarFlow.refreshModels')?.();
    expect(shown).toHaveBeenCalledWith('Settings are read-only.');
  });
});

describe('providerIdArg', () => {
  it('accepts an id or an object carrying one', () => {
    expect(providerIdArg('litellm')).toBe('litellm');
    expect(providerIdArg({ providerId: 'a' })).toBe('a');
    expect(providerIdArg({ id: 'b' })).toBe('b');
    expect(providerIdArg(undefined)).toBeUndefined();
    expect(providerIdArg('  ')).toBeUndefined();
    expect(providerIdArg(vscode.Uri.file('/x.workflow.yaml'))).toBeUndefined();
  });
});

describe('vscodeProviderSettings', () => {
  it('writes to the user settings unless the workspace defines providers', async () => {
    const update = fakeConfig({ globalValue: [{ id: 'a' }] });
    const store = vscodeProviderSettings();
    expect(store.entries()).toEqual([{ id: 'a' }]);
    await store.save([]);
    expect(update).toHaveBeenCalledWith('providers', [], vscode.ConfigurationTarget.Global);
  });

  it('edits the workspace value when the workspace defines providers', async () => {
    const update = fakeConfig({ workspaceValue: [{ id: 'w' }], globalValue: [{ id: 'g' }] });
    const store = vscodeProviderSettings();
    expect(store.entries()).toEqual([{ id: 'w' }]);
    await store.save([{ id: 'w2' }]);
    expect(update).toHaveBeenCalledWith('providers', [{ id: 'w2' }], vscode.ConfigurationTarget.Workspace);
  });

  it('treats a missing or malformed value as no entries', () => {
    fakeConfig({ globalValue: { id: 'oops' } });
    expect(vscodeProviderSettings().entries()).toEqual([]);
  });
});
