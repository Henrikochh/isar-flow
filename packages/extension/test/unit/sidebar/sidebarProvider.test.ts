import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { HostToSidebar, ModelCatalog, RunRecordSummary, SidebarToHost } from '@isar-flow/core';
import type { Services } from '../../../src/contracts';
import { registerSidebar, SIDEBAR_TAB_KEY, SIDEBAR_VIEW_ID } from '../../../src/sidebar/sidebarProvider';
import { fakeContext, fakeLog, installFakeWorkspace } from '../store/fakeWorkspace';

const FLOW_URI = 'file:///ws/a.workflow.yaml';
const finished: RunRecordSummary = {
  runId: 'old',
  workflowUri: FLOW_URI,
  workflowName: 'A',
  status: 'success',
  startedAt: 1,
};

function fakeServices() {
  const emitters = {
    agents: new vscode.EventEmitter<void>(),
    workflows: new vscode.EventEmitter<void>(),
    models: new vscode.EventEmitter<void>(),
    runs: new vscode.EventEmitter<void>(),
    history: new vscode.EventEmitter<void>(),
  };
  const catalog: ModelCatalog = { models: [], providers: [], loading: false };
  const listAgents = vi.fn(() => []);
  const services = {
    context: fakeContext(),
    output: fakeLog().log,
    agents: { onDidChange: emitters.agents.event, list: listAgents },
    workflows: { onDidChange: emitters.workflows.event, list: () => [], usersOfAgent: () => [] },
    models: { onDidChange: emitters.models.event, catalog: () => catalog },
    runs: {
      onDidChangeRuns: emitters.runs.event,
      history: { onDidChange: emitters.history.event, list: () => [finished] },
      active: () => [
        {
          runId: 'r',
          workflowUri: FLOW_URI,
          view: { runId: 'r', workflowName: 'A', status: 'running', startedAt: 5 },
        },
      ],
    },
  } as unknown as Services;
  return { services, emitters, listAgents };
}

function fakeView() {
  const incoming = new vscode.EventEmitter<SidebarToHost>();
  const disposed = new vscode.EventEmitter<void>();
  const posted: HostToSidebar[] = [];
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: incoming.event,
    postMessage: async (message: HostToSidebar) => posted.push(message) > 0,
  };
  const view = { webview, onDidDispose: disposed.event } as unknown as vscode.WebviewView;
  return { view, webview, incoming, disposed, posted };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let registration: vscode.Disposable | undefined;
afterEach(() => {
  registration?.dispose();
  vi.useRealTimers();
});

function register(services: Services) {
  let provider: vscode.WebviewViewProvider | undefined;
  let options: unknown;
  Object.assign(vscode.window, {
    registerWebviewViewProvider: (id: string, p: vscode.WebviewViewProvider, o: unknown) => {
      expect(id).toBe(SIDEBAR_VIEW_ID);
      provider = p;
      options = o;
      return { dispose: () => undefined };
    },
  });
  registration = registerSidebar(services);
  if (!provider) throw new Error('provider not registered');
  return { provider, options };
}

describe('sidebar provider', () => {
  it('registers with a retained context and renders the sidebar view', () => {
    installFakeWorkspace(['/ws']);
    const { services } = fakeServices();
    const { provider, options } = register(services);
    expect(options).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
    const { view, webview } = fakeView();
    void provider.resolveWebviewView(
      view,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken,
    );
    expect(webview.html).toContain('data-view="sidebar"');
    expect(webview.html).toContain('<title>Isar Flow</title>');
    expect(webview.options).toMatchObject({ enableScripts: true });
  });

  it('answers ready with the state and pushes debounced updates on changes', async () => {
    installFakeWorkspace(['/ws']);
    const { services, emitters } = fakeServices();
    await services.context.workspaceState.update(SIDEBAR_TAB_KEY, 'workflows');
    const { provider } = register(services);
    const { view, incoming, posted } = fakeView();
    void provider.resolveWebviewView(
      view,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken,
    );

    incoming.fire({ type: 'ready' });
    await tick();
    expect(posted).toEqual([
      {
        type: 'state',
        state: {
          hasWorkspace: true,
          trusted: true,
          agents: [],
          workflows: [],
          catalog: { models: [], providers: [], loading: false },
          recentRuns: [finished],
          activeRuns: [{ runId: 'r', workflowUri: FLOW_URI, workflowName: 'A', startedAt: 5 }],
          tab: 'workflows',
        },
      },
    ]);

    vi.useFakeTimers();
    emitters.agents.fire();
    emitters.workflows.fire();
    emitters.models.fire();
    emitters.runs.fire();
    emitters.history.fire();
    vi.advanceTimersByTime(99);
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(posted).toHaveLength(2);
  });

  it('stores the tab in the workspace state', async () => {
    installFakeWorkspace([]);
    const { services } = fakeServices();
    const { provider } = register(services);
    const { view, incoming, posted } = fakeView();
    void provider.resolveWebviewView(
      view,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken,
    );
    incoming.fire({ type: 'ready' });
    incoming.fire({ type: 'setTab', tab: 'workflows' });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(services.context.workspaceState.get(SIDEBAR_TAB_KEY)).toBe('workflows');
    const last = posted[1];
    expect(last.state).toMatchObject({ tab: 'workflows', hasWorkspace: false });
  });

  it('stops listening when the view is disposed', async () => {
    installFakeWorkspace(['/ws']);
    const { services, emitters, listAgents } = fakeServices();
    const { provider } = register(services);
    const { view, incoming, disposed, posted } = fakeView();
    void provider.resolveWebviewView(
      view,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken,
    );
    incoming.fire({ type: 'ready' });
    await tick();
    disposed.fire();
    vi.useFakeTimers();
    emitters.agents.fire();
    emitters.history.fire();
    vi.advanceTimersByTime(500);
    // The state is built before the messenger drops the post, so no call means no listener is left.
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
  });
});
