import * as vscode from 'vscode';
import type { AgentScope, SidebarTab, SidebarToHost, WorkflowTemplateId } from '@isar-flow/core';
import type { AgentStore, RunManager, WorkflowStore } from '../contracts';
import { baseName } from '../store/paths';

export const AGENT_EDITOR = 'isarFlow.agentEditor';
export const WORKFLOW_EDITOR = 'isarFlow.workflowEditor';

const TEMPLATES: readonly WorkflowTemplateId[] = ['blank', 'review-loop', 'test-fix'];
const MAX_LISTED_USERS = 5;

export interface SidebarHandlerDeps {
  agents: Pick<AgentStore, 'list' | 'create' | 'delete'>;
  workflows: Pick<WorkflowStore, 'create' | 'usersOfAgent'>;
  runs: Pick<RunManager, 'start' | 'cancel'>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  /** Modal question; resolves true when the user picked `action`. */
  confirm(message: string, action: string, detail?: string): Thenable<boolean>;
  setTab(tab: SidebarTab): Thenable<void>;
  /** Sends the full state now. */
  pushState(): void;
  /** Sends the state after the debounce window. */
  schedulePush(): void;
}

function usedByDetail(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const shown = paths.slice(0, MAX_LISTED_USERS).join(', ');
  const more = paths.length - MAX_LISTED_USERS;
  return more > 0 ? `Used by ${shown} and ${more} more.` : `Used by ${shown}.`;
}

/** Handles messages from the sidebar webview. Values are checked because they cross the webview boundary. */
export function createSidebarHandler(deps: SidebarHandlerDeps): (message: SidebarToHost) => Promise<void> {
  const open = (uri: vscode.Uri, editor: string) => deps.executeCommand('vscode.openWith', uri, editor);

  return async (message) => {
    switch (message.type) {
      case 'ready':
        deps.pushState();
        return;
      case 'setTab':
        if (message.tab !== 'agents' && message.tab !== 'workflows') return;
        await deps.setTab(message.tab);
        deps.schedulePush();
        return;
      case 'openAgent':
        await open(vscode.Uri.parse(message.uri), AGENT_EDITOR);
        return;
      case 'createAgent': {
        const scope: AgentScope = message.scope === 'user' ? 'user' : 'workspace';
        await open(await deps.agents.create(String(message.name ?? ''), scope), AGENT_EDITOR);
        return;
      }
      case 'deleteAgent': {
        const uri = vscode.Uri.parse(message.uri);
        const agent = deps.agents.list().find((a) => a.uri === message.uri);
        const users = agent && !agent.shadowed ? deps.workflows.usersOfAgent(agent.id) : [];
        const confirmed = await deps.confirm(
          `Delete agent '${agent?.name ?? baseName(uri.path)}'? Workflows that use it will stop working.`,
          'Delete',
          usedByDetail(users),
        );
        if (confirmed) await deps.agents.delete(uri);
        return;
      }
      case 'openWorkflow':
        await open(vscode.Uri.parse(message.uri), WORKFLOW_EDITOR);
        return;
      case 'createWorkflow': {
        const template = TEMPLATES.includes(message.template) ? message.template : 'blank';
        await open(await deps.workflows.create(String(message.name ?? ''), template), WORKFLOW_EDITOR);
        return;
      }
      case 'runWorkflow': {
        // The canvas shows the live run, so it opens first.
        const uri = vscode.Uri.parse(message.uri);
        await open(uri, WORKFLOW_EDITOR);
        await deps.runs.start(uri);
        return;
      }
      case 'cancelRun':
        deps.runs.cancel(message.runId);
        return;
      case 'openRun':
        await deps.executeCommand('isarFlow.internal.showRun', message.workflowUri, message.runId);
        return;
      case 'addProvider':
        await deps.executeCommand('isarFlow.addProvider');
        return;
      case 'editProvider':
      case 'setProviderKey':
      case 'removeProvider':
        await deps.executeCommand(`isarFlow.${message.type}`, message.providerId);
        return;
      case 'refreshModels':
        await deps.executeCommand('isarFlow.refreshModels');
        return;
    }
  };
}
