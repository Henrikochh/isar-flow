import * as vscode from 'vscode';
import type {
  AgentScope,
  AgentStarter,
  SidebarTab,
  SidebarToHost,
  WorkflowTemplateId,
} from '@isar-flow/core';
import { AGENT_FOLDER_PROMPT, type FolderChoice, WORKFLOW_FOLDER_PROMPT } from '../commands/folders';
import type { AgentStore, MemoryService, RunManager, SetupCheck, WorkflowStore } from '../contracts';

export const AGENT_EDITOR = 'isarFlow.agentEditor';
export const WORKFLOW_EDITOR = 'isarFlow.workflowEditor';

const TEMPLATES: readonly WorkflowTemplateId[] = ['blank', 'review-loop', 'test-fix'];
const STARTERS: readonly AgentStarter[] = ['blank', 'coder', 'reviewer'];
const MAX_QUERY_LENGTH = 200;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

export interface SidebarHandlerDeps {
  agents: Pick<AgentStore, 'create' | 'delete'>;
  workflows: Pick<WorkflowStore, 'create'>;
  runs: Pick<RunManager, 'start' | 'cancel'>;
  setupCheck?: Pick<SetupCheck, 'dismiss'>;
  memory?: Pick<MemoryService, 'open'>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  setTab(tab: SidebarTab): Thenable<void>;
  /** Sends the full state now. */
  pushState(): void;
  /** Sends the state after the debounce window. */
  schedulePush(): void;
  /** The workspace folder to create in; asks in a multi-root workspace. */
  pickFolder(placeHolder: string): Promise<FolderChoice>;
}

/**
 * Handles messages from the sidebar webview. Values are checked because they cross the webview boundary.
 * Deleting an agent and removing a provider are confirmed inline in the sidebar, so they run without a dialog.
 */
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
        const starter = STARTERS.find((s) => s === message.starter) ?? 'blank';
        const folder = scope === 'workspace' ? await deps.pickFolder(AGENT_FOLDER_PROMPT) : undefined;
        if (folder === 'dismissed') return;
        const options = folder ? { folder } : {};
        await open(
          await deps.agents.create(String(message.name ?? ''), scope, starter, options),
          AGENT_EDITOR,
        );
        return;
      }
      case 'deleteAgent':
        // The store only deletes files in an agent folder, and moves them to the trash.
        await deps.agents.delete(vscode.Uri.parse(message.uri));
        return;
      case 'openWorkflow':
        await open(vscode.Uri.parse(message.uri), WORKFLOW_EDITOR);
        return;
      case 'createWorkflow': {
        const template = TEMPLATES.includes(message.template) ? message.template : 'blank';
        const folder = await deps.pickFolder(WORKFLOW_FOLDER_PROMPT);
        if (folder === 'dismissed') return;
        await open(
          await deps.workflows.create(String(message.name ?? ''), template, folder),
          WORKFLOW_EDITOR,
        );
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
        await deps.executeCommand(`isarFlow.${message.type}`, message.providerId);
        return;
      case 'removeProvider':
        await deps.executeCommand('isarFlow.removeProvider', message.providerId, { confirmed: true });
        return;
      case 'refreshModels':
        await deps.executeCommand('isarFlow.refreshModels');
        return;
      case 'testModel': {
        const ref = nonEmpty(message.ref);
        const providerId = nonEmpty(message.providerId);
        if (ref) await deps.executeCommand('isarFlow.testModel', ref);
        else if (providerId) await deps.executeCommand('isarFlow.testModel', { providerId });
        else await deps.executeCommand('isarFlow.testModel');
        return;
      }
      case 'checkSetup':
        // The sidebar shows the report, so the command neither reveals it nor notifies.
        await deps.executeCommand('isarFlow.checkSetup', { quiet: true });
        return;
      case 'dismissSetupCheck':
        deps.setupCheck?.dismiss();
        return;
      case 'openSettings': {
        const query = nonEmpty(message.query);
        if (query && query.length <= MAX_QUERY_LENGTH) {
          await deps.executeCommand('workbench.action.openSettings', query);
        }
        return;
      }
      case 'openMemory': {
        // Created with a short header when missing; without a folder URI the first folder's file.
        const folderUri = nonEmpty(message.folderUri);
        await deps.memory?.open(folderUri ? vscode.Uri.parse(folderUri) : undefined);
        return;
      }
    }
  };
}
