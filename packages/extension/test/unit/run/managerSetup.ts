import * as vscode from 'vscode';
import { expect, vi } from 'vitest';
import type { AgentDefinition, ModelCatalog, RunEvent, Workflow } from '@isar-flow/core';
import type {
  AgentStore,
  CodeContextCapture,
  ConsoleRunOptions,
  MemoryService,
  ModelRegistry,
  RunConsoleCommand,
  RunManagerDeps,
  SimulationStore,
} from '../../../src/contracts';
import { createApprovalBroker } from '../../../src/run/approvals';
import { createAskBroker, type AskUi } from '../../../src/run/asks';
import { createRunHistory } from '../../../src/run/history';
import { createRunManager, type RunManagerUi, type RunStatusItem } from '../../../src/run/runManager';
import { WorkflowSecrets } from '../../../src/run/secrets';
import { FakeMemento, FakeSecretStorage, FakeTerminal, fakeSimulations, memoryStore } from './fakes';
import { fakeSafety, type FakeSafetyOptions } from './safetyFakes';

export const CONSOLE_WORKFLOW = `version: 1
name: Build
steps:
  - id: build
    type: console
    run: npm run build
`;

export class FakeStatusItem implements RunStatusItem {
  text = '';
  tooltip?: string;
  command?: vscode.Command;
  name?: string;
  shown = false;
  disposed = false;
  show(): void {
    this.shown = true;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export const exitZero: RunConsoleCommand = async (options) => {
  options.onData('stdout', 'built\n');
  return { exitCode: 0, stdout: 'built\n', stderr: '', output: 'built\n', timedOut: false };
};

/** Runs until aborted, like a long-running process that gets killed. */
export const untilAborted: RunConsoleCommand = (options) =>
  new Promise((resolve) => {
    options.signal.addEventListener('abort', () =>
      resolve({ exitCode: 1, stdout: '', stderr: '', output: '', timedOut: false }),
    );
  });

export interface Setup {
  text?: string;
  trusted?: boolean;
  runCommand?: RunConsoleCommand;
  settings?: Record<string, unknown>;
  agents?: Record<string, AgentDefinition>;
  catalog?: ModelCatalog;
  inputs?: Record<string, unknown> | undefined;
  confirm?: string | undefined;
  /** Button "clicked" on notifications. */
  click?: string;
  env?: Record<string, string | undefined>;
  modal?: boolean;
  /** Workspace folder of the workflow; null for a workflow outside all folders. */
  folder?: string | null;
  /** Folder console commands run in. */
  root?: string;
  safety?: FakeSafetyOptions;
  /** Simulation files; a fake without mocks by default. */
  simulations?: SimulationStore;
  /** Pause per simulated host call, so tests can cancel a simulation (0 by default). */
  simulationDelayMs?: number;
  /** Keep the run manager's own pause per simulated call instead. */
  defaultSimulationDelay?: boolean;
  /** An editor of the workflow is attached (default true): finished runs only report changed files. */
  editorVisible?: boolean;
  /** Window access of the ask broker (notifications, QuickPick, InputBox). */
  askUi?: Partial<AskUi>;
  codeContext?: CodeContextCapture;
  memory?: MemoryService;
}

/** A run manager with fakes for everything outside the engine. */
export function setup(options: Setup = {}) {
  const uri = vscode.Uri.file('/ws/.isarflow/workflows/build.workflow.yaml');
  const terminal = new FakeTerminal();
  const logLines: string[] = [];
  const log = {
    info: (m: string) => logLines.push(`info: ${m}`),
    warn: (m: string) => logLines.push(`warn: ${m}`),
    error: (m: string) => logLines.push(`error: ${m}`),
    debug: () => undefined,
    trace: () => undefined,
  } as unknown as vscode.LogOutputChannel;
  const commands: ConsoleRunOptions[] = [];
  const contextReads: { root: string | undefined; globs: string[] }[] = [];
  const runCommand = options.runCommand ?? exitZero;
  const context = {
    workspaceState: new FakeMemento(),
    globalState: new FakeMemento(),
    secrets: new FakeSecretStorage(),
    subscriptions: [],
  };
  const deps: RunManagerDeps = {
    context: context as unknown as vscode.ExtensionContext,
    models: {
      catalog: () => options.catalog ?? { models: [], providers: [], loading: false },
      resolve: async () => Promise.reject(new Error('No models in unit tests')),
    } as unknown as ModelRegistry,
    agents: { definitions: () => options.agents ?? {} } as unknown as AgentStore,
    log,
    runCommand: (o) => {
      commands.push(o);
      return runCommand(o);
    },
    tools: vi.fn(() => ({ execute: async () => ({ content: '' }) })),
    terminalFor: vi.fn(() => terminal),
    readContextFiles: async (globs) => {
      contextReads.push({ root: undefined, globs });
      return [];
    },
    ...(options.codeContext && { codeContext: options.codeContext }),
    ...(options.memory && { memory: options.memory }),
  };

  const notifications: { kind: string; message: string; buttons: string[] }[] = [];
  const notify =
    (kind: string) =>
    async (message: string, ...buttons: string[]) => {
      notifications.push({ kind, message, buttons });
      return options.click;
    };
  const statusItems: FakeStatusItem[] = [];
  const settings: Record<string, unknown> = { ...options.settings };
  const ui: RunManagerUi = {
    isTrusted: () => options.trusted ?? true,
    showInfo: notify('info'),
    showWarning: notify('warning'),
    showError: notify('error'),
    executeCommand: vi.fn(async () => undefined),
    readText: vi.fn(async () => options.text ?? CONSOLE_WORKFLOW),
    setting: <T>(key: string, fallback: T) => (key in settings ? (settings[key] as T) : fallback),
    workspaceFolder: vi.fn(() => (options.folder === null ? undefined : (options.folder ?? '/ws'))),
    workspaceRoot: vi.fn(() => options.root ?? '/ws'),
    promptInputs: vi.fn(async (_workflow: Workflow) => ('inputs' in options ? options.inputs : {})),
    confirmCommands: vi.fn(async () => ('confirm' in options ? options.confirm : 'Run')),
    createStatusItem: () => {
      const item = new FakeStatusItem();
      statusItems.push(item);
      return item;
    },
  };
  const history = createRunHistory(memoryStore(), new FakeMemento(), () => 50);
  const secrets = new WorkflowSecrets(context);
  const approvals = createApprovalBroker({
    notify: async () => ((options.modal ?? true) ? 'Approve' : 'Reject'),
    info: () => undefined,
    openWorkflow: async () => undefined,
  });
  const asks = createAskBroker({
    notify: async () => undefined,
    info: () => undefined,
    warn: (message) => logLines.push(`warn: ${message}`),
    openWorkflow: async () => undefined,
    ...options.askUi,
  });
  if (options.editorVisible ?? true) asks.attach(uri.toString());
  const safety = fakeSafety(options.safety);
  const simulations = options.simulations ?? fakeSimulations();
  const manager = createRunManager(deps, {
    safety: safety.safety,
    simulations,
    ...(!options.defaultSimulationDelay && { simulationDelayMs: options.simulationDelayMs ?? 0 }),
    ui,
    history,
    secrets,
    approvals,
    asks,
    env: options.env ?? { PATH: '/bin' },
    readContextFilesIn: (root) => async (globs) => {
      contextReads.push({ root, globs });
      return [];
    },
  });
  const events: RunEvent[] = [];
  manager.onEvent(({ workflowUri, event }) => {
    expect(workflowUri).toBe(uri.toString());
    events.push(event);
  });
  const runsChanged = vi.fn();
  manager.onDidChangeRuns(runsChanged);
  return {
    uri,
    manager,
    deps,
    ui,
    terminal,
    logLines,
    commands,
    contextReads,
    notifications,
    statusItems,
    settings,
    events,
    runsChanged,
    secrets,
    approvals,
    asks,
    safety,
    history,
    simulations,
  };
}
