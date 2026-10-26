import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createModelRegistry, readModelSettings } from '../../../src/models/registry';

/** A configuration section where the user and the workspace both define `providers`. */
function config(user: unknown, workspace: unknown) {
  const effective = workspace ?? user;
  return {
    get: <T>(key: string, fallback?: T) => (key === 'providers' ? (effective as T) : fallback) as T,
    inspect: <T>(key: string) =>
      key === 'providers'
        ? { key: `isarFlow.${key}`, defaultValue: [] as T, globalValue: user as T, workspaceValue: workspace as T }
        : undefined,
  };
}

const USER = [{ id: 'litellm', baseUrl: 'http://localhost:4000' }];
const WORKSPACE = [{ id: 'litellm', baseUrl: 'https://attacker.example/v1' }];

afterEach(() => vi.restoreAllMocks());

describe('model settings and workspace trust', () => {
  it('ignores endpoints from the workspace settings while the workspace is not trusted', () => {
    // The stored key of 'litellm' would otherwise be sent to the workspace's base URL.
    expect(readModelSettings(config(USER, WORKSPACE), false).providers).toEqual(USER);
    expect(readModelSettings(config(undefined, WORKSPACE), false).providers).toEqual([]);
  });

  it('uses the effective value in a trusted workspace', () => {
    expect(readModelSettings(config(USER, WORKSPACE), true).providers).toEqual(WORKSPACE);
  });

  it('refreshes when the workspace becomes trusted', async () => {
    const trust = new vscode.EventEmitter<void>();
    vi.spyOn(vscode.workspace, 'onDidGrantWorkspaceTrust').mockImplementation(trust.event);
    const getConfig = vi.fn(() => ({ providers: [], vscodeModels: false }));
    const registry = createModelRegistry({
      context: {
        secrets: { onDidChange: () => ({ dispose: () => undefined }), get: async () => undefined },
      } as unknown as vscode.ExtensionContext,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel,
      getConfig,
      lm: { selectChatModels: async () => [], onDidChangeChatModels: () => ({ dispose: () => undefined }) },
      createClient: () => ({ listModels: async () => [], model: () => Promise.reject(new Error('unused')) }) as never,
    });
    await registry.refresh();
    expect(getConfig).toHaveBeenCalledTimes(1);

    trust.fire();
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
    registry.dispose();
  });
});
