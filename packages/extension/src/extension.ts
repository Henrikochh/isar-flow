import path from 'node:path';
import * as vscode from 'vscode';
import type { ShellName, ToolHost } from '@isar-flow/core';
import { registerCodeLens } from './codelens';
import { registerCreateCommands } from './commands/create';
import { registerWorkflowCommands } from './commands/workflowCommands';
import type { RunTerminal, Services, ToolHostFactory } from './contracts';
import { registerDiagnostics } from './diagnostics';
import { registerAgentEditor } from './editors/agentEditor';
import { registerWorkflowEditor } from './editors/workflowEditor';
import { createModelRegistry, registerModelCommands } from './models';
import { createContextFileReader } from './run/contextFiles';
import { createRunManager, type WorkflowRunManager } from './run/runManager';
import { registerSecretCommands, WorkflowSecrets } from './run/secrets';
import { runConsoleCommand } from './runner/consoleRunner';
import { createRunTerminal } from './runner/runTerminal';
import { registerSidebar } from './sidebar/sidebarProvider';
import { createAgentStore, type IndexedAgentStore } from './store/agentStore';
import { createWorkflowStore, type IndexedWorkflowStore } from './store/workflowStore';
import { createPermissionPrompt } from './tools/permissionPrompt';
import { createToolHost } from './tools/toolHost';
import { createVscodeWorkspaceAdapter } from './tools/vscodeWorkspace';

/** Returned from activate(); integration tests drive the extension through it. */
export interface IsarFlowApi extends Services {
  agents: IndexedAgentStore;
  workflows: IndexedWorkflowStore;
  runs: WorkflowRunManager;
}

const NO_FOLDER_TOOL_ERROR = 'Agent tools need an open folder. Open a folder in VS Code and run again.';

/** Folder that agent tools and context files are confined to. */
const workspaceRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

export function activate(context: vscode.ExtensionContext): IsarFlowApi {
  const output = vscode.window.createOutputChannel('Isar Flow', { log: true });
  context.subscriptions.push(output);

  const models = createModelRegistry({ context, log: output });
  context.subscriptions.push(models, registerModelCommands(context, models));

  const agents = createAgentStore({ context, log: output });
  context.subscriptions.push(agents);

  // One host per run: "Allow for this run" lives in the host, and the root and shell are read at run start.
  const prompt = createPermissionPrompt();
  const tools: ToolHostFactory = (runId) => {
    const root = workspaceRoot();
    if (!root) return noFolderToolHost;
    return createToolHost({
      runId,
      workspaceRoot: root,
      workspace: createVscodeWorkspaceAdapter(root),
      runCommand: runConsoleCommand,
      prompt,
      defaultShell: vscode.workspace.getConfiguration('isarFlow').get<ShellName>('defaultShell', 'auto'),
    });
  };

  const terminals = new Map<string, RunTerminal>();
  const terminalFor = (workflowName: string): RunTerminal => {
    let terminal = terminals.get(workflowName);
    if (!terminal) {
      terminal = createRunTerminal(`Isar Flow: ${workflowName}`);
      terminals.set(workflowName, terminal);
    }
    return terminal;
  };
  context.subscriptions.push({
    dispose: () => {
      for (const terminal of terminals.values()) terminal.dispose();
      terminals.clear();
    },
  });

  const contextFiles = createVscodeWorkspaceAdapter();
  const readContextFiles = createContextFileReader(
    (glob, max) => contextFiles.findFiles(glob, max),
    (relPath) => {
      const root = workspaceRoot();
      if (!root) return Promise.reject(new Error('No workspace folder is open.'));
      return contextFiles.readFile(path.join(root, relPath));
    },
  );

  const secrets = new WorkflowSecrets(context);
  context.subscriptions.push(registerSecretCommands(context, secrets));

  const runs = createRunManager(
    {
      context,
      models,
      agents,
      log: output,
      runCommand: runConsoleCommand,
      tools,
      terminalFor,
      readContextFiles,
    },
    { secrets },
  );
  context.subscriptions.push(runs);
  // Warms the cache so history.get(runId) answers synchronously for recent runs.
  runs.history.loadAll().catch((error: unknown) => {
    output.warn(`Could not load the run history: ${error instanceof Error ? error.message : String(error)}`);
  });

  const workflows = createWorkflowStore({ context, log: output, agents, history: runs.history });
  context.subscriptions.push(workflows);

  const services: IsarFlowApi = { context, agents, workflows, models, runs, tools, output };
  context.subscriptions.push(
    registerSidebar(services),
    registerCreateCommands(services),
    registerWorkflowEditor(services),
    registerAgentEditor(services),
    registerDiagnostics(services),
    registerCodeLens(services),
    registerWorkflowCommands(services),
  );

  output.info(`Isar Flow ${String(context.extension.packageJSON.version)} activated.`);
  return services;
}

export function deactivate(): void {}

/** Used when no folder is open: agents still run, but every tool call explains why it was refused. */
const noFolderToolHost: ToolHost = {
  execute: async () => ({ isError: true, content: NO_FOLDER_TOOL_ERROR }),
};
