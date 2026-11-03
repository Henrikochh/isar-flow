import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDefinition,
  AgentSummary,
  ModelCatalog,
  ModelProbeResult,
  ProviderSummary,
  SetupReport,
  WorkflowSummary,
} from '@isar-flow/core';
import * as vscode from 'vscode';
import { createSetupCheck, readWorkflowText, type SetupCheckDeps } from '../../../src/models/setupCheck';

const LITELLM: ProviderSummary = {
  id: 'litellm',
  label: 'LiteLLM',
  kind: 'openai-compatible',
  baseUrl: 'http://localhost:4000',
  hasApiKey: true,
  status: 'ok',
  modelCount: 12,
};
const VSCODE: ProviderSummary = {
  id: 'vscode',
  label: 'VS Code',
  kind: 'vscode',
  hasApiKey: false,
  status: 'ok',
  modelCount: 2,
};
const CATALOG: ModelCatalog = { models: [], providers: [VSCODE, LITELLM], loading: false };

const workflow = (relativePath: string): WorkflowSummary => ({
  uri: `file:///ws/${relativePath}`,
  name: relativePath.replace('.workflow.yaml', ''),
  relativePath,
  valid: true,
  stepCount: 1,
});

const agentFlow = (model: string, agent = 'coder') =>
  `version: 1\nname: Flow\nsteps:\n  - id: a\n    type: agent\n    agent: ${agent}\n    model: ${model}\n    prompt: Hi\n`;

const CODER: AgentSummary = {
  id: 'coder',
  name: 'Coder',
  model: 'litellm/gpt-4.1',
  tools: ['readFile'],
  scope: 'workspace',
  uri: 'file:///ws/.isarflow/agents/coder.agent.yaml',
  valid: true,
};
const DEFINITIONS: Record<string, AgentDefinition> = {
  coder: { name: 'Coder', model: 'litellm/gpt-4.1', tools: ['readFile'] },
};

const result = (ref: string, outcome: ModelProbeResult['outcome'] = 'tools'): ModelProbeResult => ({
  ref,
  outcome,
  message: outcome === 'tools' ? 'Tool calls work' : outcome === 'text' ? 'Needs text tool mode' : 'Failed.',
  toolCalls: outcome === 'tools',
  json: true,
  latencyMs: 500,
  testedAt: 1,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function setup(files: Record<string, string>, overrides: Partial<SetupCheckDeps> = {}) {
  const probe = vi.fn(async (ref: string, _signal?: AbortSignal) => result(ref));
  const log = { info: vi.fn(), warn: vi.fn() };
  let time = 100;
  const deps: SetupCheckDeps = {
    models: { refresh: vi.fn(async () => CATALOG), catalog: () => CATALOG, probe },
    workflows: { list: () => Object.keys(files).map(workflow) },
    agents: { list: () => [CODER], definitions: () => DEFINITIONS },
    log,
    readText: async (uri) => {
      const text = files[uri.replace('file:///ws/', '')];
      if (text === undefined) throw new Error('FileNotFound');
      return text;
    },
    now: () => (time += 10),
    ...overrides,
  };
  const check = createSetupCheck(deps);
  const reports: (SetupReport | undefined)[] = [];
  check.onDidChange(() => reports.push(check.current()));
  return { check, deps, probe, log, reports };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('setup check', () => {
  it('checks the endpoints and tests every model a workflow uses', async () => {
    const { check, probe, log } = setup({
      'b.workflow.yaml': agentFlow('litellm/gpt-4.1'),
      'a.workflow.yaml': agentFlow('litellm/mini'),
      'broken.workflow.yaml': '- not a workflow\n',
    });

    const report = await check.run();

    expect(report.finishedAt).toBeGreaterThan(report.startedAt);
    expect(report.items.map((i) => [i.id, i.status, i.message])).toEqual([
      ['endpoint:vscode', 'ok', '2 models'],
      ['endpoint:litellm', 'ok', 'Reachable, 12 models'],
      ['model:litellm/gpt-4.1', 'ok', 'Tool calls work (0.5 s)'],
      ['model:litellm/mini', 'ok', 'Tool calls work (0.5 s)'],
    ]);
    expect(report.items[2].usedBy).toEqual(['b.workflow.yaml', 'coder']);
    expect(probe.mock.calls.map(([ref]) => ref)).toEqual(['litellm/gpt-4.1', 'litellm/mini']);
    expect(check.current()).toEqual(report);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('broken.workflow.yaml'));
  });

  it('shows the report while it runs and tests one model at a time', async () => {
    const gates = [deferred<ModelProbeResult>(), deferred<ModelProbeResult>()];
    const { check, probe, reports } = setup(
      { 'a.workflow.yaml': agentFlow('litellm/one'), 'b.workflow.yaml': agentFlow('litellm/two') },
      {},
    );
    probe.mockImplementation((_ref: string) => gates[probe.mock.calls.length - 1].promise);

    const done = check.run();
    expect(check.run()).toBe(done);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    const running = check.current();
    expect(running?.finishedAt).toBeUndefined();
    expect(running?.items.at(-1)).toMatchObject({
      id: 'model:litellm/one',
      status: 'running',
      message: 'Testing…',
    });

    gates[0].resolve(result('litellm/one', 'text'));
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(check.current()?.items.map((i) => i.status)).toEqual(['ok', 'ok', 'warning', 'running']);

    gates[1].resolve(result('litellm/two', 'failed'));
    const report = await done;
    expect(report.items.slice(2).map((i) => i.status)).toEqual(['warning', 'error']);
    expect(reports[0]).toEqual({ startedAt: expect.any(Number), items: [] });
    expect(reports.at(-1)).toEqual(report);
  });

  it('starts a new check after the previous one finished', async () => {
    const { check, probe } = setup({ 'a.workflow.yaml': agentFlow('litellm/one') });
    const first = await check.run();
    const second = await check.run();
    expect(second).not.toBe(first);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('says when no workflow uses a model', async () => {
    const { check, probe } = setup({ 'a.workflow.yaml': 'version: 1\nname: A\nsteps: []\n' });
    const report = await check.run();
    expect(report.items.at(-1)).toEqual({
      id: 'model:none',
      kind: 'model',
      label: 'Models',
      status: 'skipped',
      message: 'No workflow uses a model yet.',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not test models of endpoints with a problem', async () => {
    const down: ProviderSummary = { ...LITELLM, status: 'error', errorKind: 'network' };
    const broken = { ...CATALOG, providers: [VSCODE, down] };
    const { check, probe } = setup(
      { 'a.workflow.yaml': agentFlow('litellm/one') },
      { models: { refresh: async () => broken, catalog: () => broken, probe: vi.fn() } },
    );
    const report = await check.run();
    expect(report.items.map((i) => i.status)).toEqual(['ok', 'error', 'error']);
    expect(report.items[2].message).toBe('Not tested because LiteLLM has a problem. Fix the endpoint first.');
    expect(probe).not.toHaveBeenCalled();
  });

  it('stops waiting for endpoints that do not answer', async () => {
    vi.useFakeTimers();
    const loading = {
      ...CATALOG,
      providers: [VSCODE, { ...LITELLM, status: 'loading' as const }],
      loading: true,
    };
    const { check } = setup(
      { 'a.workflow.yaml': agentFlow('litellm/one') },
      {
        models: {
          refresh: () => new Promise<ModelCatalog>(() => undefined),
          catalog: () => loading,
          probe: vi.fn(),
        },
        refreshTimeoutMs: 30_000,
      },
    );
    const pending = check.run();
    await vi.advanceTimersByTimeAsync(30_000);
    const report = await pending;
    expect(report.items[1]).toMatchObject({ id: 'endpoint:litellm', status: 'error' });
  });

  it('uses the current catalog when refreshing fails', async () => {
    const { check, log } = setup(
      { 'a.workflow.yaml': agentFlow('litellm/one') },
      {
        models: {
          refresh: async () => Promise.reject(new Error('settings broken')),
          catalog: () => CATALOG,
          probe: async (ref) => result(ref),
        },
      },
    );
    expect((await check.run()).items).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('settings broken'));
  });

  it('skips workflows it cannot read', async () => {
    const { check, log } = setup(
      { 'a.workflow.yaml': agentFlow('litellm/one') },
      { workflows: { list: () => [workflow('a.workflow.yaml'), workflow('gone.workflow.yaml')] } },
    );
    expect((await check.run()).items).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('gone.workflow.yaml'));
  });

  it('reports models as not tested when the registry cannot test them', async () => {
    const { check } = setup(
      { 'a.workflow.yaml': agentFlow('litellm/one') },
      { models: { refresh: async () => CATALOG, catalog: () => CATALOG } },
    );
    expect((await check.run()).items.at(-1)).toMatchObject({ status: 'skipped', message: 'Not tested.' });
  });

  it('dismisses the report and stops a running check', async () => {
    const { check, probe, reports } = setup({
      'a.workflow.yaml': agentFlow('litellm/one'),
      'b.workflow.yaml': agentFlow('litellm/two'),
    });
    const gate = deferred<ModelProbeResult>();
    probe.mockImplementation(() => gate.promise);
    const pending = check.run();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    const signal = probe.mock.calls[0][1];

    check.dismiss();
    expect(signal?.aborted).toBe(true);
    expect(check.current()).toBeUndefined();
    expect(reports.at(-1)).toBeUndefined();

    gate.resolve(result('litellm/one'));
    const partial = await pending;
    expect(partial.finishedAt).toBeDefined();
    expect(partial.items.at(-1)).toMatchObject({ status: 'skipped', message: 'Not tested.' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(check.current()).toBeUndefined();

    probe.mockImplementation(async (ref: string) => result(ref));
    await check.run();
    expect(check.current()?.finishedAt).toBeDefined();
    check.dismiss();
    expect(check.current()).toBeUndefined();
  });
});

describe('readWorkflowText', () => {
  it('reads unsaved text of an open editor, else the file', async () => {
    const open = { uri: vscode.Uri.file('/ws/open.workflow.yaml'), getText: () => 'unsaved' };
    const documents = vscode.workspace.textDocuments;
    Object.assign(vscode.workspace, { textDocuments: [open] });
    const readFile = vi
      .spyOn(vscode.workspace.fs, 'readFile')
      .mockResolvedValue(new TextEncoder().encode('﻿on disk'));
    try {
      expect(await readWorkflowText(open.uri.toString())).toBe('unsaved');
      expect(await readWorkflowText('file:///ws/closed.workflow.yaml')).toBe('on disk');
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(vscode.workspace, { textDocuments: documents });
    }
  });
});
