import * as vscode from 'vscode';
import type { AgentScope, WorkflowTemplateId } from '@isar-flow/core';
import type { AgentStore, Services, WorkflowStore } from '../contracts';
import { AGENT_EDITOR, WORKFLOW_EDITOR } from '../sidebar/sidebarMessages';
import type { AgentKind } from '../store/agentIndex';
import { errorMessage } from '../store/files';

/** The VS Code UI used by the create flows (injected for tests). */
export interface CreateUi {
  hasWorkspace(): boolean;
  showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: T[],
    options: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
}

interface TemplateItem extends vscode.QuickPickItem {
  template: WorkflowTemplateId;
}
interface StarterItem extends vscode.QuickPickItem {
  starter: AgentKind;
}
interface ScopeItem extends vscode.QuickPickItem {
  scope: AgentScope;
}

const TEMPLATE_ITEMS: TemplateItem[] = [
  { label: 'Blank', description: 'Start empty', template: 'blank' },
  { label: 'Review loop', description: 'Implement, test and review until approved', template: 'review-loop' },
  { label: 'Test and fix', description: 'Run tests and fix failures until they pass', template: 'test-fix' },
];

const STARTER_ITEMS: StarterItem[] = [
  { label: 'Blank', description: 'Reads files; you add instructions and tools', starter: 'blank' },
  { label: 'Coder', description: 'Implements tasks and fixes failing tests', starter: 'coder' },
  { label: 'Reviewer', description: 'Strict code reviewer that answers in JSON', starter: 'reviewer' },
];

const SCOPE_ITEMS: ScopeItem[] = [
  {
    label: 'Workspace',
    description: 'Saved in .isarflow/agents and shared with the repository',
    scope: 'workspace',
  },
  { label: 'User', description: 'Available in all your workspaces', scope: 'user' },
];

const requireName = (value: string) => (value.trim() === '' ? 'Enter a name.' : undefined);

/** Asks for a name and a template, then creates and opens the workflow. Undefined when the user cancels. */
export async function newWorkflowFlow(
  ui: CreateUi,
  workflows: WorkflowStore,
): Promise<vscode.Uri | undefined> {
  if (!ui.hasWorkspace()) throw new Error('Open a folder first to create workflows.');
  const title = 'New workflow';
  const name = await ui.showInputBox({
    title,
    prompt: 'Name of the workflow',
    placeHolder: 'e.g. Review until approved',
    validateInput: requireName,
    ignoreFocusOut: true,
  });
  if (name === undefined) return undefined;
  const picked = await ui.showQuickPick(TEMPLATE_ITEMS, { title, placeHolder: 'Start from' });
  if (!picked) return undefined;
  const uri = await workflows.create(name.trim(), picked.template);
  await ui.executeCommand('vscode.openWith', uri, WORKFLOW_EDITOR);
  return uri;
}

/** Asks for a name, a starter and (with a folder open) the scope, then creates and opens the agent. */
export async function newAgentFlow(ui: CreateUi, agents: AgentStore): Promise<vscode.Uri | undefined> {
  const title = 'New agent';
  const name = await ui.showInputBox({
    title,
    prompt: 'Name of the agent',
    placeHolder: 'e.g. Reviewer',
    validateInput: requireName,
    ignoreFocusOut: true,
  });
  if (name === undefined) return undefined;
  const start = await ui.showQuickPick(STARTER_ITEMS, { title, placeHolder: 'Start from' });
  if (!start) return undefined;
  let scope: AgentScope = 'user';
  if (ui.hasWorkspace()) {
    const picked = await ui.showQuickPick(SCOPE_ITEMS, {
      title,
      placeHolder: 'Where should the agent be saved?',
    });
    if (!picked) return undefined;
    scope = picked.scope;
  }
  const uri = await agents.create(name.trim(), scope, start.starter);
  await ui.executeCommand('vscode.openWith', uri, AGENT_EDITOR);
  return uri;
}

export function registerCreateCommands(services: Services): vscode.Disposable {
  const ui: CreateUi = {
    hasWorkspace: () => (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
    showInputBox: (options) => vscode.window.showInputBox(options),
    showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  };
  const guarded = (what: string, flow: () => Promise<unknown>) => async () => {
    try {
      await flow();
    } catch (error) {
      services.output.error(`${what} failed: ${errorMessage(error)}`);
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  };
  return vscode.Disposable.from(
    vscode.commands.registerCommand(
      'isarFlow.newWorkflow',
      guarded('New workflow', () => newWorkflowFlow(ui, services.workflows)),
    ),
    vscode.commands.registerCommand(
      'isarFlow.newAgent',
      guarded('New agent', () => newAgentFlow(ui, services.agents)),
    ),
  );
}
