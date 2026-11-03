import * as vscode from 'vscode';
import { registerCodeLens } from './codelens';
import { registerCreateCommands } from './commands/create';
import { registerMemoryCommand } from './commands/memoryCommand';
import { registerWorkflowCommands } from './commands/workflowCommands';
import { createCodeContextCapture } from './context/codeContext';
import { registerSelectionCommand } from './context/selectionCommand';
import type {
  CodeContextCapture,
  MemoryService,
  RunManagerDeps,
  RunTerminal,
  Services,
  SetupCheck,
  TriggerService,
} from './contracts';
import { type CopilotRegistration, registerCopilot } from './copilot/registerCopilot';
import { registerDiagnostics } from './diagnostics';
import { registerAgentEditor } from './editors/agentEditor';
import { registerWorkflowEditor } from './editors/workflowEditor';
import { registerLiveValueHover } from './liveValues/hoverProvider';
import { createMemoryService } from './memory/memoryService';
import {
  createModelRegistry,
  createSetupCheck,
  registerModelCommands,
  registerSetupCommands,
} from './models';
import { registerReportCommands } from './report/reportCommands';
import { createWorkspaceContextReader } from './run/contextFiles';
import { createRunManager, type WorkflowRunManager } from './run/runManager';
import { registerSecretCommands, WorkflowSecrets } from './run/secrets';
import { runConsoleCommand } from './runner/consoleRunner';
import { createRunTerminal } from './runner/runTerminal';
import { registerSidebar } from './sidebar/sidebarProvider';
import { createAgentStore, type IndexedAgentStore } from './store/agentStore';
import { createWorkflowStore, type IndexedWorkflowStore } from './store/workflowStore';
import { createPermissionPrompt } from './tools/permissionPrompt';
import { createToolHostFactory } from './tools/toolHostFactory';
import { createVscodeWorkspaceAdapter } from './tools/vscodeWorkspace';
import { createTriggerService } from './triggers/triggerService';

/** Returned from activate(); integration tests drive the extension through it. */
export interface IsarFlowApi extends Services {
  agents: IndexedAgentStore;
  workflows: IndexedWorkflowStore;
  runs: WorkflowRunManager;
  setupCheck: SetupCheck;
  triggers: TriggerService;
  memory: MemoryService;
  codeContext: CodeContextCapture;
  /**
   * The Copilot tools and the @isarflow handler. Integration tests call them here: vscode.lm.invokeTool outside a
   * chat shows the run confirmation as a modal dialog.
   */
  copilot: CopilotRegistration;
}

/** Default folder for agent tools and context files; runs use the workflow's own folder. */
const firstFolder = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

/** The run manager of the active extension, so deactivate() can wait for stopped runs to be saved. */
let activeRuns: WorkflowRunManager | undefined;

export function activate(context: vscode.ExtensionContext): IsarFlowApi {
  const output = vscode.window.createOutputChannel('Isar Flow', { log: true });
  context.subscriptions.push(output);

  const models = createModelRegistry({ context, log: output });
  context.subscriptions.push(models, registerModelCommands(context, models));

  const agents = createAgentStore({ context, log: output });
  context.subscriptions.push(agents);

  const tools = createToolHostFactory({
    defaultRoot: firstFolder,
    workspace: (root) => createVscodeWorkspaceAdapter(root),
    defaultShell: (root) =>
      vscode.workspace
        .getConfiguration('isarFlow', vscode.Uri.file(root))
        .get<string>('defaultShell', 'auto'),
    runCommand: runConsoleCommand,
    prompt: createPermissionPrompt(),
  });

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

  const readContextFilesIn = (root: string): RunManagerDeps['readContextFiles'] =>
    createWorkspaceContextReader(root, createVscodeWorkspaceAdapter(root));
  const readContextFiles: RunManagerDeps['readContextFiles'] = (globs, signal) => {
    const root = firstFolder();
    if (!root) return Promise.reject(new Error('No workspace folder is open.'));
    return readContextFilesIn(root)(globs, signal);
  };

  // editor.* / git.* at run start, and .isarflow/memory.md for agents.
  const codeContext = createCodeContextCapture({ log: output });
  const memory = createMemoryService({ log: output });
  context.subscriptions.push(codeContext, memory);

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
      codeContext,
      memory,
    },
    { secrets, readContextFilesIn },
  );
  context.subscriptions.push(runs);
  activeRuns = runs;
  // Warms the cache so history.get(runId) answers synchronously for recent runs.
  runs.history.loadAll().catch((error: unknown) => {
    output.warn(`Could not load the run history: ${error instanceof Error ? error.message : String(error)}`);
  });

  const workflows = createWorkflowStore({ context, log: output, agents, history: runs.history });
  context.subscriptions.push(workflows);

  const triggers = createTriggerService({ runs, workflows, log: output });
  context.subscriptions.push(triggers);

  const setupCheck = createSetupCheck({ models, workflows, agents, log: output });
  context.subscriptions.push(setupCheck, registerSetupCommands({ registry: models, setupCheck, agents }));

  const services = {
    context,
    agents,
    workflows,
    models,
    runs,
    tools,
    output,
    setupCheck,
    triggers,
    memory,
    codeContext,
  } satisfies Services;
  const copilot = registerCopilot(services);
  context.subscriptions.push(
    copilot,
    registerSidebar(services),
    registerCreateCommands(services),
    registerWorkflowEditor(services),
    registerAgentEditor(services),
    registerDiagnostics(services),
    registerCodeLens(services),
    registerLiveValueHover(services),
    registerWorkflowCommands(services),
    registerSelectionCommand(services),
    registerReportCommands(services),
    registerMemoryCommand(memory),
  );

  output.info(`Isar Flow ${String(context.extension.packageJSON.version)} activated.`);
  return { ...services, copilot };
}

/** VS Code waits for the returned promise, so runs stopped by the shutdown still reach the history. */
export async function deactivate(): Promise<void> {
  const runs = activeRuns;
  activeRuns = undefined;
  await runs?.shutdown();
}
