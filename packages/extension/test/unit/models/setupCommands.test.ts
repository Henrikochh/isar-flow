import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type {
  ChatModelInfo,
  ModelCatalog,
  ModelProbeResult,
  ProviderSummary,
  SetupReport,
} from '@isar-flow/core';
import pkg from '../../../package.json';
import {
  createSetupCommands,
  registerSetupCommands,
  type SetupCommandDeps,
  type SetupCommandUi,
  testModelArg,
} from '../../../src/models/setupCommands';

afterEach(() => vi.restoreAllMocks());

const model = (provider: string, id: string, label = provider): ChatModelInfo => ({
  ref: `${provider}/${id}`,
  provider,
  providerLabel: label,
  id,
  name: id.toUpperCase(),
  capabilities: { tools: true, jsonSchema: true },
});

const provider = (id: string, label: string, kind: ProviderSummary['kind'] = 'openai-compatible') => ({
  id,
  label,
  kind,
  hasApiKey: false,
  status: 'ok' as const,
  modelCount: 2,
});

const CATALOG: ModelCatalog = {
  models: [
    model('vscode', 'copilot/gpt-4.1', 'VS Code'),
    model('litellm', 'a', 'LiteLLM'),
    model('litellm', 'b', 'LiteLLM'),
  ],
  providers: [
    provider('vscode', 'VS Code', 'vscode'),
    provider('litellm', 'LiteLLM'),
    provider('empty', 'Empty'),
  ],
  loading: false,
  probes: {
    'litellm/b': {
      ref: 'litellm/b',
      outcome: 'text',
      message: 'Needs text tool mode',
      toolCalls: false,
      json: true,
      testedAt: 1,
    },
  },
};

const result = (
  ref: string,
  outcome: ModelProbeResult['outcome'],
  message = outcome === 'tools' ? 'Tool calls work' : 'Needs text tool mode',
): ModelProbeResult => ({
  ref,
  outcome,
  message,
  toolCalls: outcome === 'tools',
  json: true,
  latencyMs: 812,
  testedAt: 1,
});

type Item = vscode.QuickPickItem & { ref?: string };

class FakeUi implements SetupCommandUi {
  readonly shown: string[] = [];
  readonly picks: Item[][] = [];
  readonly progressTitles: string[] = [];
  pickAnswer: (items: Item[]) => Item | undefined = () => undefined;
  answer: string | undefined;
  cancel = false;

  async pick<T extends vscode.QuickPickItem>(items: T[]) {
    this.picks.push(items);
    return this.pickAnswer(items) as T | undefined;
  }
  async info(message: string, ...actions: string[]) {
    this.shown.push(`info: ${message}${actions.length ? ` [${actions.join(', ')}]` : ''}`);
    return this.answer;
  }
  async warn(message: string, ...actions: string[]) {
    this.shown.push(`warn: ${message}${actions.length ? ` [${actions.join(', ')}]` : ''}`);
    return this.answer;
  }
  async error(message: string, ...actions: string[]) {
    this.shown.push(`error: ${message}${actions.length ? ` [${actions.join(', ')}]` : ''}`);
    return this.answer;
  }
  async progress<T>(title: string, task: (signal: AbortSignal) => Promise<T>) {
    this.progressTitles.push(title);
    const controller = new AbortController();
    if (this.cancel) controller.abort();
    return task(controller.signal);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<SetupCommandDeps> = {}) {
  const ui = new FakeUi();
  const executed: unknown[][] = [];
  const probe = vi.fn(async (ref: string, _signal?: AbortSignal) => result(ref, 'tools'));
  const report: SetupReport = { startedAt: 1, finishedAt: 2, items: [] };
  const setupCheck = {
    run: vi.fn(async () => report),
    current: vi.fn((): SetupReport | undefined => report),
  };
  const deps: SetupCommandDeps = {
    registry: { catalog: () => CATALOG, probe },
    setupCheck,
    usedModels: () => ['litellm/b', 'ollama/unlisted'],
    ui,
    isTrusted: () => true,
    executeCommand: async (...args: unknown[]) => void executed.push(args),
    ...overrides,
  };
  return { commands: createSetupCommands(deps), ui, executed, probe, setupCheck, report };
}

describe('testModelArg', () => {
  it('accepts a reference, { ref } or { providerId }', () => {
    expect(testModelArg('litellm/a')).toEqual({ ref: 'litellm/a' });
    expect(testModelArg({ ref: ' litellm/a ' })).toEqual({ ref: 'litellm/a' });
    expect(testModelArg({ providerId: 'litellm' })).toEqual({ providerId: 'litellm' });
    expect(testModelArg(undefined)).toEqual({});
    expect(testModelArg({ ref: 3 })).toEqual({});
    expect(testModelArg(vscode.Uri.file('/x'))).toEqual({});
  });
});

describe('Test model command', () => {
  it('tests the given model with a cancellable progress and reports the latency', async () => {
    const { commands, ui, probe } = setup();
    await commands.testModel('litellm/a');
    expect(ui.progressTitles).toEqual(['Testing litellm/a…']);
    expect(probe).toHaveBeenCalledWith('litellm/a', expect.any(AbortSignal));
    expect(ui.shown).toEqual(['info: litellm/a: Tool calls work (0.8 s).']);
  });

  it('suggests text tool mode', async () => {
    const { commands, ui, probe } = setup();
    probe.mockResolvedValueOnce(result('litellm/b', 'text'));
    await commands.testModel({ ref: 'litellm/b' });
    expect(ui.shown).toEqual([
      'warn: litellm/b: Needs text tool mode. In the agents that use it, set Tool calls to Text in the prompt.',
    ]);
  });

  it('offers the fix of a failure', async () => {
    const { commands, ui, probe, executed } = setup();
    probe.mockResolvedValueOnce(
      result('litellm/a', 'failed', 'The API key was rejected. Set a new API key for LiteLLM.'),
    );
    ui.answer = 'Set API key';
    await commands.testModel('litellm/a');
    await flush();
    expect(ui.shown).toEqual([
      'error: litellm/a: The API key was rejected. Set a new API key for LiteLLM. [Set API key]',
    ]);
    expect(executed).toEqual([['isarFlow.setProviderKey', 'litellm']]);

    probe.mockResolvedValueOnce(result('gone/m', 'failed', "Unknown model provider 'gone' in 'gone/m'."));
    ui.answer = undefined;
    await commands.testModel('gone/m');
    expect(ui.shown.at(-1)).toBe("error: gone/m: Unknown model provider 'gone' in 'gone/m'. [Add endpoint]");

    probe.mockResolvedValueOnce(result('litellm/a', 'failed', 'The endpoint is rate limiting requests.'));
    await commands.testModel('litellm/a');
    expect(ui.shown.at(-1)).toBe('error: litellm/a: The endpoint is rate limiting requests.');
  });

  it('says nothing when the test was cancelled', async () => {
    const { commands, ui, probe } = setup();
    ui.cancel = true;
    probe.mockResolvedValueOnce(result('litellm/a', 'failed', 'The test was cancelled.'));
    await commands.testModel('litellm/a');
    expect(ui.shown).toEqual([]);
  });

  it('lets the user pick a model: used ones first, then by provider', async () => {
    const { commands, ui, probe } = setup();
    ui.pickAnswer = (items) => items.find((i) => i.ref === 'litellm/a');
    await commands.testModel();
    const items = ui.picks[0];
    expect(items.map((i) => (i.ref === undefined ? `-- ${i.label}` : i.ref))).toEqual([
      '-- Used by your agents',
      'litellm/b',
      'ollama/unlisted',
      '-- VS Code',
      'vscode/copilot/gpt-4.1',
      '-- LiteLLM',
      'litellm/a',
    ]);
    expect(items[0].kind).toBe(-1);
    expect(items[1]).toMatchObject({
      label: 'B',
      description: 'litellm/b',
      detail: 'Last test: Needs text tool mode',
    });
    expect(items[2]).toMatchObject({ label: 'ollama/unlisted', description: 'ollama/unlisted' });
    expect(probe).toHaveBeenCalledWith('litellm/a', expect.any(AbortSignal));
  });

  it("picks among one provider's models", async () => {
    const { commands, ui, probe } = setup();
    await commands.testModel({ providerId: 'litellm' });
    expect(ui.picks[0].filter((i) => i.ref).map((i) => i.ref)).toEqual(['litellm/b', 'litellm/a']);
    expect(probe).not.toHaveBeenCalled();

    await commands.testModel({ providerId: 'empty' });
    expect(ui.shown).toEqual(['info: Empty lists no models to test.']);
    await commands.testModel({ providerId: 'nope' });
    expect(ui.shown.at(-1)).toBe("error: There is no model endpoint 'nope'.");
  });

  it('explains when there is nothing to test', async () => {
    const empty = { models: [], providers: [], loading: false };
    const { commands, ui, executed } = setup({
      registry: { catalog: () => empty, probe: vi.fn() },
      usedModels: () => [],
    });
    ui.answer = 'Add model endpoint';
    await commands.testModel();
    await flush();
    expect(ui.shown).toEqual(['info: There are no models to test yet. [Add model endpoint]']);
    expect(executed).toEqual([['isarFlow.addProvider']]);
  });

  it('refuses in Restricted Mode', async () => {
    const { commands, ui, probe } = setup({ isTrusted: () => false });
    await commands.testModel('litellm/a');
    expect(ui.shown).toEqual(['error: Trust this workspace to test models.']);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('Check setup command', () => {
  const item = (status: 'ok' | 'warning' | 'error') => ({
    id: `x:${status}`,
    kind: 'endpoint' as const,
    label: 'x',
    status,
    message: status,
  });

  it('runs the check, shows the sidebar and the result', async () => {
    const { commands, ui, executed, setupCheck, report } = setup();
    report.items = [item('ok'), item('warning'), item('error')];
    ui.answer = 'Show';
    await commands.checkSetup();
    await flush();
    expect(setupCheck.run).toHaveBeenCalled();
    expect(ui.shown).toEqual(['warn: Setup check found 2 problems. [Show]']);
    expect(executed).toEqual([['workbench.view.extension.isarFlow'], ['workbench.view.extension.isarFlow']]);

    report.items = [item('error')];
    ui.answer = undefined;
    await commands.checkSetup();
    expect(ui.shown.at(-1)).toBe('warn: Setup check found 1 problem. [Show]');

    report.items = [item('ok')];
    await commands.checkSetup();
    expect(ui.shown.at(-1)).toBe('info: Setup check passed.');
  });

  it('stays quiet when started from the sidebar or dismissed meanwhile', async () => {
    const { commands, ui, executed, setupCheck } = setup();
    await commands.checkSetup({ quiet: true });
    expect(ui.shown).toEqual([]);
    expect(executed).toEqual([]);

    setupCheck.current.mockReturnValue(undefined);
    await commands.checkSetup();
    expect(ui.shown).toEqual([]);
  });

  it('refuses in Restricted Mode', async () => {
    const { commands, ui, setupCheck } = setup({ isTrusted: () => false });
    await commands.checkSetup();
    expect(ui.shown).toEqual(['error: Trust this workspace to check the setup.']);
    expect(setupCheck.run).not.toHaveBeenCalled();
  });
});

describe('registerSetupCommands', () => {
  it('registers both contributed commands', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      handlers.set(id, handler);
      return new vscode.Disposable(() => handlers.delete(id));
    });
    const shown = vi.fn(async (_message: string) => undefined);
    vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(shown);
    const setupCheck = {
      run: vi.fn(async () => Promise.reject(new Error('broken'))),
      current: () => undefined,
    };
    const disposable = registerSetupCommands({
      registry: { catalog: () => CATALOG, probe: vi.fn() },
      setupCheck,
      agents: { list: () => [], definitions: () => ({}) },
    });
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    expect([...handlers.keys()]).toEqual(['isarFlow.testModel', 'isarFlow.checkSetup']);
    for (const id of handlers.keys()) expect(contributed.has(id)).toBe(true);

    await handlers.get('isarFlow.checkSetup')?.();
    expect(shown).toHaveBeenCalledWith('broken');
    disposable.dispose();
    expect(handlers.size).toBe(0);
  });
});
