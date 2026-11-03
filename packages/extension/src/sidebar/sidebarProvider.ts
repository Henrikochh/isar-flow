import * as vscode from 'vscode';
import type { HostToSidebar, SidebarState, SidebarToHost } from '@isar-flow/core';
import { pickWorkspaceFolder } from '../commands/folders';
import type { Services } from '../contracts';
import { debounce } from '../store/debounce';
import { renderWebviewHtml, webviewOptions } from '../webview/html';
import { Messenger } from '../webview/messenger';
import { createSidebarHandler } from './sidebarMessages';
import { buildSidebarState } from './sidebarState';

export const SIDEBAR_VIEW_ID = 'isarFlow.sidebar';
export const SIDEBAR_TAB_KEY = 'isarFlow.sidebar.tab';
const PUSH_DELAY_MS = 100;

export function registerSidebar(services: Services): vscode.Disposable {
  const provider = new SidebarViewProvider(services);
  return vscode.Disposable.from(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider,
  );
}

class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private viewDisposables: vscode.Disposable[] = [];

  constructor(private readonly services: Services) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    const { context, output, agents, workflows, models, runs, setupCheck, memory } = this.services;
    view.webview.options = webviewOptions(context.extensionUri);
    view.webview.html = renderWebviewHtml(view.webview, context.extensionUri, 'sidebar', 'Isar Flow');

    const push = () => messenger.post({ type: 'state', state: this.state() });
    const pushSoon = debounce(push, PUSH_DELAY_MS);
    const handler = createSidebarHandler({
      agents,
      workflows,
      runs,
      setupCheck,
      memory,
      executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
      setTab: (tab) => context.workspaceState.update(SIDEBAR_TAB_KEY, tab),
      pushState: push,
      schedulePush: () => pushSoon.trigger(),
      pickFolder: (placeHolder) =>
        pickWorkspaceFolder(
          {
            workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
            showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
          },
          placeHolder,
        ),
    });
    const messenger = new Messenger<SidebarToHost, HostToSidebar>(view.webview, handler, output);
    const changed = () => pushSoon.trigger();
    this.viewDisposables.push(
      messenger,
      { dispose: () => pushSoon.dispose() },
      agents.onDidChange(changed),
      workflows.onDidChange(changed),
      models.onDidChange(changed),
      runs.onDidChangeRuns(changed),
      runs.history.onDidChange(changed),
      ...(setupCheck ? [setupCheck.onDidChange(changed)] : []),
      ...(memory ? [memory.onDidChange(changed)] : []),
      vscode.workspace.onDidGrantWorkspaceTrust(changed),
      vscode.workspace.onDidChangeWorkspaceFolders(changed),
      view.onDidDispose(() => this.disposeView()),
    );
  }

  dispose(): void {
    this.disposeView();
  }

  private state(): SidebarState {
    const { context, agents, workflows, models, runs, setupCheck, memory } = this.services;
    return buildSidebarState({
      hasWorkspace: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
      trusted: vscode.workspace.isTrusted,
      agents: agents.list(),
      workflows: workflows.list(),
      catalog: models.catalog(),
      history: runs.history.list(),
      activeRuns: runs.active(),
      tab: context.workspaceState.get(SIDEBAR_TAB_KEY),
      setupCheck: setupCheck?.current(),
      ...(memory && { memory: memory.files() }),
    });
  }

  private disposeView(): void {
    for (const d of this.viewDisposables.splice(0)) d.dispose();
  }
}
