import path from 'node:path';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, ModelCatalog, RunEvent, Workflow } from '@isar-flow/core';
import type {
  AgentStore,
  ConsoleRunOptions,
  ModelRegistry,
  RunConsoleCommand,
  RunManagerDeps,
} from '../../../src/contracts';
import { createApprovalBroker } from '../../../src/run/approvals';
import { createRunHistory } from '../../../src/run/history';
import { createRunManager, type RunManagerUi, type RunStatusItem } from '../../../src/run/runManager';
import { WorkflowSecrets } from '../../../src/run/secrets';
import { FakeMemento, FakeSecretStorage, FakeTerminal, flush, memoryStore } from './fakes';

const CONSOLE_WORKFLOW = `version: 1
name: Build
steps:
  - id: build
    type: console
    run: npm run build
`;

class FakeStatusItem implements RunStatusItem {
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

const exitZero: RunConsoleCommand = async (options) => {
  options.onData('stdout', 'built\n');
  return { exitCode: 0, stdout: 'built\n', stderr: '', output: 'built\n', timedOut: false };
};

/** Runs until aborted, like a long-running process that gets killed. */
const untilAborted: RunConsoleCommand = (options) =>
  new Promise((resolve) => {
    options.signal.addEventListener('abort', () =>
      resolve({ exitCode: 1, stdout: '', stderr: '', output: '', timedOut: false }),
    );
  });

interface Setup {
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
}

function setup(options: Setup = {}) {
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
  const approvals = createApprovalBroker({ modal: async () => options.modal ?? true });
  const manager = createRunManager(deps, {
    ui,
    history,
    secrets,
    approvals,
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
  };
}

describe('createRunManager', () => {
  it('runs a console workflow end to end', async () => {
    const t = setup();
    const runId = await t.manager.start(t.uri);
    expect(runId).toMatch(/^run-[0-9a-z]+/);
    expect(t.manager.active(t.uri.toString())).toHaveLength(1);

    const view = await t.manager.whenFinished(runId as string);
    expect(view?.status).toBe('success');
    expect(view?.steps.build.status).toBe('success');
    expect(t.events.map((e) => e.type)).toEqual([
      'run-start',
      'step-start',
      'step-log',
      'step-end',
      'run-end',
    ]);
    expect(t.commands[0]).toMatchObject({ command: 'npm run build', shell: 'auto' });
    expect(t.deps.terminalFor).toHaveBeenCalledWith('Build');
    expect(t.terminal.text).toContain('▶ build');
    expect(t.manager.active()).toEqual([]);
    expect(t.runsChanged).toHaveBeenCalledTimes(2);

    const [record] = t.manager.history.list(t.uri.toString());
    expect(record).toMatchObject({ runId, status: 'success', workflowName: 'Build' });
    expect(t.manager.history.get(runId as string)?.steps.build.status).toBe('success');

    expect(t.logLines.some((l) => l.startsWith('info:') && l.includes(runId as string))).toBe(true);
    expect(t.logLines.some((l) => l.includes('succeeded'))).toBe(true);
  });

  it('shows a status bar item while running that opens the workflow editor', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    const [item] = t.statusItems;
    expect(item.shown).toBe(true);
    expect(item.text).toMatch(/^\$\(sync~spin\) Build 0:0\d$/);
    expect(item.command).toMatchObject({
      command: 'vscode.openWith',
      arguments: [t.uri, 'isarFlow.workflowEditor'],
    });
    t.manager.cancel(runId);
    await t.manager.whenFinished(runId);
    expect(item.disposed).toBe(true);
  });

  it('refuses to run in untrusted workspaces', async () => {
    const t = setup({ trusted: false, click: 'Manage Workspace Trust' });
    expect(await t.manager.start(t.uri)).toBeUndefined();
    await flush();
    expect(t.notifications[0]).toMatchObject({ kind: 'warning', buttons: ['Manage Workspace Trust'] });
    expect(t.notifications[0].message).toMatch(/trust/i);
    expect(t.ui.executeCommand).toHaveBeenCalledWith('workbench.trust.manage');
    expect(t.ui.readText).not.toHaveBeenCalled();
    expect(t.commands).toHaveLength(0);
  });

  it('refuses a second run of the same workflow while one is live', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    expect(await t.manager.start(t.uri)).toBeUndefined();
    await flush();
    expect(t.notifications).toContainEqual({
      kind: 'info',
      message: 'This workflow is already running.',
      buttons: [],
    });
    t.manager.cancel(runId);
    await t.manager.whenFinished(runId);
  });

  it('stops runs on shutdown and resolves once they are saved to the history', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    await flush();
    await t.manager.shutdown();
    expect(t.manager.history.list(t.uri.toString()).map((r) => [r.runId, r.status])).toEqual([
      [runId, 'cancelled'],
    ]);
    expect(t.manager.active()).toEqual([]);
    expect(await t.manager.start(t.uri)).toBeUndefined();
  });

  it('ends a cancelled run as cancelled and saves it', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    await flush();
    expect(t.manager.active(t.uri.toString())[0].view.activeStepId).toBe('build');

    t.manager.cancel(runId);
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('cancelled');
    const end = t.events.at(-1);
    expect(end).toMatchObject({ type: 'run-end', status: 'cancelled' });
    expect(t.manager.history.list()[0]).toMatchObject({ runId, status: 'cancelled' });
    expect(t.manager.active()).toEqual([]);
  });

  it('blocks runs of invalid workflows and points to the problems', async () => {
    const t = setup({
      text: 'version: 1\nname: Bad\nsteps:\n  - id: a\n    type: console\n',
      click: 'Show problems',
    });
    expect(await t.manager.start(t.uri)).toBeUndefined();
    await flush();
    expect(t.notifications[0]).toMatchObject({
      kind: 'error',
      message: 'Fix 1 problem in build.workflow.yaml before running.',
      buttons: ['Show problems'],
    });
    expect(t.ui.executeCommand).toHaveBeenCalledWith('workbench.actions.view.problems');
    expect(t.commands).toHaveLength(0);
  });

  it('counts YAML syntax errors and unknown agents as problems', async () => {
    const syntax = setup({ text: 'version: 1\nname: [oops\n' });
    expect(await syntax.manager.start(syntax.uri)).toBeUndefined();
    await flush();
    expect(syntax.notifications[0].message).toMatch(
      /^Fix \d+ problems? in build\.workflow\.yaml before running\.$/,
    );

    const agentText = `version: 1
name: Ask
steps:
  - id: ask
    type: agent
    agent: coder
    prompt: Hi
  - id: ask2
    type: agent
    agent: missing
    prompt: Hi
`;
    const unknownAgent = setup({ text: agentText, agents: { coder: { name: 'Coder', model: 'x/y' } } });
    expect(await unknownAgent.manager.start(unknownAgent.uri)).toBeUndefined();
    await flush();
    expect(unknownAgent.notifications[0].message).toBe(
      'Fix 1 problem in build.workflow.yaml before running.',
    );

    const known = setup({
      text: agentText.replace('agent: missing', 'agent: coder'),
      agents: { coder: { name: 'Coder', model: 'x/y' } },
    });
    const runId = await known.manager.start(known.uri);
    expect(runId).toBeDefined();
    expect((await known.manager.whenFinished(runId as string))?.status).toBe('failure');
  });

  it('asks for inputs only when none are given', async () => {
    const text = `version: 1
name: Greet
inputs:
  who: { type: string, required: true }
steps:
  - id: hello
    type: console
    run: echo \${{ inputs.who }}
`;
    const asked = setup({ text, inputs: { who: 'world' } });
    const runId = (await asked.manager.start(asked.uri)) as string;
    await asked.manager.whenFinished(runId);
    expect(asked.ui.promptInputs).toHaveBeenCalledTimes(1);
    expect(asked.commands[0].command).toBe('echo world');

    const given = setup({ text });
    const second = (await given.manager.start(given.uri, { who: 'you' })) as string;
    await given.manager.whenFinished(second);
    expect(given.ui.promptInputs).not.toHaveBeenCalled();
    expect(given.commands[0].command).toBe('echo you');

    const cancelled = setup({ text, inputs: undefined });
    expect(await cancelled.manager.start(cancelled.uri)).toBeUndefined();
    expect(cancelled.commands).toHaveLength(0);
  });

  it('confirms console commands unless remembered or disabled', async () => {
    const declined = setup({ confirm: undefined });
    expect(await declined.manager.start(declined.uri)).toBeUndefined();
    expect(declined.commands).toHaveLength(0);
    const [message, detail] = (declined.ui.confirmCommands as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(message).toBe("Run 'Build'? It runs these commands in your workspace:");
    expect(detail).toContain('npm run build');

    const remembered = setup({ confirm: 'Run and remember' });
    await remembered.manager.whenFinished((await remembered.manager.start(remembered.uri)) as string);
    await remembered.manager.whenFinished((await remembered.manager.start(remembered.uri)) as string);
    expect(remembered.ui.confirmCommands).toHaveBeenCalledTimes(1);

    const disabled = setup({ settings: { confirmCommands: false } });
    await disabled.manager.whenFinished((await disabled.manager.start(disabled.uri)) as string);
    expect(disabled.ui.confirmCommands).not.toHaveBeenCalled();
  });

  it('passes settings, secrets and the process environment to the engine', async () => {
    const text = `version: 1
name: Env
steps:
  - id: show
    type: console
    run: echo \${{ env.GREETING }} \${{ secrets.TOKEN }}
`;
    const t = setup({ text, settings: { defaultShell: 'bash' }, env: { GREETING: 'hi', EMPTY: undefined } });
    await t.secrets.set('TOKEN', 's3cret');
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    expect(t.commands[0]).toMatchObject({ command: 'echo hi s3cret', shell: 'bash' });
  });

  it("works in the workflow's own workspace folder", async () => {
    const text = `version: 1
name: Folder
steps:
  - id: build
    type: console
    run: npm run build
    cwd: app
  - id: ask
    type: agent
    agent: coder
    prompt: Hi
    context:
      files: [README.md]
`;
    const agents = { coder: { name: 'Coder', model: 'x/y' } };
    const t = setup({ text, agents, folder: '/second', root: '/second' });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    expect(t.ui.workspaceFolder).toHaveBeenCalledWith(t.uri);
    expect(t.commands[0].cwd).toBe(path.resolve('/second', 'app'));
    expect(t.deps.tools).toHaveBeenCalledWith(runId, '/second');
    expect(t.contextReads).toEqual([{ root: '/second', globs: ['README.md'] }]);
  });

  it('keeps agent tools and context files out of the folder of a workflow outside all folders', async () => {
    const text = `version: 1
name: Loose
steps:
  - id: build
    type: console
    run: npm run build
  - id: ask
    type: agent
    agent: coder
    prompt: Hi
    context:
      files: [README.md]
`;
    const t = setup({
      text,
      agents: { coder: { name: 'Coder', model: 'x/y' } },
      folder: null,
      root: '/loose',
    });
    const runId = (await t.manager.start(t.uri)) as string;
    await t.manager.whenFinished(runId);
    // Console commands run beside the file; tools and context files use the default (first) folder.
    expect(t.commands[0].cwd).toBe(path.resolve('/loose'));
    expect(t.deps.tools).toHaveBeenCalledWith(runId, undefined);
    expect(t.contextReads).toEqual([{ root: undefined, globs: ['README.md'] }]);
  });

  it('logs failed blocks and saves failed runs', async () => {
    const t = setup({
      runCommand: async () => ({ exitCode: 2, stdout: '', stderr: 'nope', output: 'nope', timedOut: false }),
    });
    const runId = (await t.manager.start(t.uri)) as string;
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('failure');
    expect(
      t.logLines.some((l) => l.startsWith('warn:') && l.includes("'build'") && l.includes('code 2')),
    ).toBe(true);
    expect(t.manager.history.list()[0].status).toBe('failure');
  });

  it('routes approvals to an attached editor and cancels them with the run', async () => {
    const text = `version: 1
name: Gate
steps:
  - id: gate
    type: approval
    message: Ship it?
`;
    const t = setup({ text });
    const resolved = vi.fn();
    t.manager.approvals.onDidResolve(resolved);
    const requests: string[] = [];
    t.manager.approvals.onDidRequest((r) => requests.push(r.requestId));
    t.manager.approvals.attach(t.uri.toString());

    const approvedRun = (await t.manager.start(t.uri)) as string;
    await flush();
    t.manager.approvals.respond(requests[0], { approved: true });
    expect((await t.manager.whenFinished(approvedRun))?.status).toBe('success');

    const cancelledRun = (await t.manager.start(t.uri)) as string;
    await flush();
    expect(requests).toHaveLength(2);
    t.manager.cancel(cancelledRun);
    expect((await t.manager.whenFinished(cancelledRun))?.status).toBe('cancelled');
    expect(resolved).toHaveBeenCalledTimes(2);
  });

  it('aborts live runs on dispose', async () => {
    const t = setup({ runCommand: untilAborted });
    const runId = (await t.manager.start(t.uri)) as string;
    const finished = t.manager.whenFinished(runId);
    t.manager.dispose();
    expect((await finished)?.status).toBe('cancelled');
  });
});
