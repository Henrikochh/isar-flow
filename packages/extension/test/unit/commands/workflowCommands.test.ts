import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  blockHashes,
  parseWorkflowText,
  type RunRecordSummary,
  type RunView,
  type WorkflowSummary,
} from '@isar-flow/core';
import type { ActiveRun } from '../../../src/contracts';
import {
  createWorkflowCommands,
  uriArg,
  WORKFLOW_COMMAND_IDS,
  type WorkflowCommandServices,
  type WorkflowCommandUi,
} from '../../../src/commands/workflowCommands';

const WORKFLOW = 'file:///ws/.isarflow/workflows/build.workflow.yaml';
const OTHER = 'file:///ws/deploy.workflow.yml';
const AGENT = 'file:///ws/.isarflow/agents/coder.agent.yaml';
const FLOW = `version: 1
name: Build
steps:
  - id: first
    type: console
    run: echo one
  - id: tests
    type: console
    run: npm test
`;

function summary(uri: string, name: string, valid = true): WorkflowSummary {
  return { uri, name, relativePath: uri.replace('file:///ws/', ''), valid, stepCount: 1 };
}

function activeRun(runId: string, workflowUri: string, workflowName: string): ActiveRun {
  const view: RunView = {
    runId,
    workflowName,
    status: 'running',
    startedAt: Date.UTC(2026, 9, 26, 8, 30),
    inputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: {},
  };
  return { runId, workflowUri, view };
}

function record(runId: string, extra: Partial<RunRecordSummary> = {}): RunRecordSummary {
  return { runId, workflowUri: WORKFLOW, workflowName: 'Build', status: 'failure', startedAt: 1, ...extra };
}

/** A failed run of `text` that stopped at tests, with the block hashes of that text. */
function savedRun(runId: string, text: string): RunView {
  return {
    runId,
    workflowName: 'Build',
    status: 'failure',
    startedAt: 1,
    inputs: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: {
      first: { status: 'success', executions: 1, logs: [], output: { status: 'success', exitCode: 0 } },
      tests: { status: 'failure', executions: 1, logs: [], output: { status: 'failure', exitCode: 1 } },
    },
    blockHashes: blockHashes(parseWorkflowText(text).workflow),
  };
}

interface SetupOptions {
  workflows?: WorkflowSummary[];
  active?: ActiveRun[];
  activeUri?: string;
  history?: RunRecordSummary[];
  /** Saved runs getAsync returns. */
  saved?: RunView[];
}

type Cursor = { text: string; line: number; character: number };

function setup(options: SetupOptions = {}) {
  const runs = options.active ?? [];
  const history = options.history ?? [];
  const services = {
    workflows: { list: vi.fn(() => options.workflows ?? []) },
    runs: {
      start: vi.fn<WorkflowCommandServices['runs']['start']>(async () => 'run-1'),
      cancel: vi.fn(),
      active: vi.fn((uri?: string) => runs.filter((r) => uri === undefined || r.workflowUri === uri)),
      history: {
        list: vi.fn((uri?: string) => history.filter((r) => uri === undefined || r.workflowUri === uri)),
        getAsync: vi.fn(async (runId: string) => options.saved?.find((run) => run.runId === runId)),
      },
      simulations: { open: vi.fn(async (_uri: vscode.Uri) => undefined) },
    },
    output: { show: vi.fn() },
  } satisfies WorkflowCommandServices;
  const ui = {
    activeUri: vi.fn(() => (options.activeUri ? vscode.Uri.parse(options.activeUri) : undefined)),
    cursor: vi.fn((_uri: vscode.Uri) => undefined as Cursor | undefined),
    readText: vi.fn(async (_uri: vscode.Uri) => FLOW),
    showQuickPick: vi.fn(),
    showInfo: vi.fn(async () => undefined as string | undefined),
    showError: vi.fn(async () => undefined),
    confirm: vi.fn(
      async (_message: string, _detail: string, _button: string) => undefined as string | undefined,
    ),
    executeCommand: vi.fn(async (_command: string, ..._args: unknown[]) => undefined as unknown),
  } satisfies WorkflowCommandUi;
  return { services, ui, commands: createWorkflowCommands(services, ui) };
}

const startedUri = (services: WorkflowCommandServices) =>
  String(vi.mocked(services.runs.start).mock.calls[0]?.[0]);

describe('uriArg', () => {
  it('accepts Uris, URI strings, file paths and objects with a uri', () => {
    const uri = vscode.Uri.parse(WORKFLOW);
    expect(uriArg(uri)).toBe(uri);
    expect(String(uriArg(WORKFLOW))).toBe(WORKFLOW);
    expect(uriArg('C:\\ws\\a.workflow.yaml')?.scheme).toBe('file');
    expect(String(uriArg({ uri: WORKFLOW }))).toBe(WORKFLOW);
    expect(String(uriArg({ workflowUri: WORKFLOW }))).toBe(WORKFLOW);
  });

  it('ignores anything else', () => {
    expect(uriArg(undefined)).toBeUndefined();
    expect(uriArg('')).toBeUndefined();
    expect(uriArg(42)).toBeUndefined();
    expect(uriArg({ id: 'x' })).toBeUndefined();
  });
});

describe('workflow commands', () => {
  it('lists the command ids it registers', () => {
    expect([...WORKFLOW_COMMAND_IDS].sort()).toEqual(
      [
        'isarFlow.cancelRun',
        'isarFlow.openInCanvas',
        'isarFlow.openSimulationFile',
        'isarFlow.openYaml',
        'isarFlow.runFromHere',
        'isarFlow.runWorkflow',
        'isarFlow.showLog',
        'isarFlow.simulateWorkflow',
      ].sort(),
    );
  });

  describe('simulateWorkflow', () => {
    it('simulates the workflow passed as argument', async () => {
      const { services, ui, commands } = setup({ activeUri: OTHER });
      await expect(commands.simulateWorkflow({ uri: WORKFLOW })).resolves.toBe('run-1');
      const [uri, inputs, options] = vi.mocked(services.runs.start).mock.calls[0];
      expect([String(uri), inputs, options]).toEqual([WORKFLOW, undefined, { simulate: true }]);
      expect(ui.showQuickPick).not.toHaveBeenCalled();
    });

    it('refuses a file that is not a workflow', async () => {
      const { services, ui, commands } = setup();
      await expect(commands.simulateWorkflow(AGENT)).resolves.toBeUndefined();
      expect(services.runs.start).not.toHaveBeenCalled();
      expect(ui.showError).toHaveBeenCalledWith(
        'coder.agent.yaml is not a workflow. Workflow files end in .workflow.yaml or .workflow.yml.',
      );
    });

    it('simulates the workflow in the active editor', async () => {
      const { services, commands } = setup({ activeUri: OTHER });
      await commands.simulateWorkflow();
      expect(startedUri(services)).toBe(OTHER);
      expect(vi.mocked(services.runs.start).mock.calls[0][2]).toEqual({ simulate: true });
    });

    it('asks which workflow to simulate when the active editor shows no workflow', async () => {
      const { services, ui, commands } = setup({ workflows: [summary(WORKFLOW, 'Build')] });
      ui.showQuickPick.mockImplementation(async (items: vscode.QuickPickItem[]) => items[0]);
      await commands.simulateWorkflow();
      expect(ui.showQuickPick.mock.calls[0][1]).toMatchObject({
        placeHolder: 'Choose a workflow to simulate',
      });
      expect(startedUri(services)).toBe(WORKFLOW);

      ui.showQuickPick.mockResolvedValue(undefined);
      await expect(commands.simulateWorkflow()).resolves.toBeUndefined();
      expect(services.runs.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('runFromHere', () => {
    const started = (services: WorkflowCommandServices) => {
      const [uri, inputs, options] = vi.mocked(services.runs.start).mock.calls[0];
      return [String(uri), inputs, options];
    };

    it('continues the newest real run at the block under the cursor', async () => {
      const history = [record('run-3', { simulated: true }), record('run-2'), record('run-1')];
      const { services, ui, commands } = setup({ activeUri: WORKFLOW, history });
      ui.cursor.mockReturnValue({ text: FLOW, line: 8, character: 9 });
      await expect(commands.runFromHere()).resolves.toBe('run-1');
      expect(started(services)).toEqual([
        WORKFLOW,
        undefined,
        { resume: { runId: 'run-2', stepId: 'tests' } },
      ]);
      expect(ui.showQuickPick).not.toHaveBeenCalled();
    });

    it('asks for the block when the cursor is in none and marks where the run stopped', async () => {
      const { services, ui, commands } = setup({
        activeUri: WORKFLOW,
        history: [record('run-2', { stoppedAt: 'tests' })],
      });
      ui.showQuickPick.mockImplementation(async (items: vscode.QuickPickItem[]) => items[1]);
      await commands.runFromHere();
      const [items, pickOptions] = ui.showQuickPick.mock.calls[0];
      expect(items).toEqual([
        expect.objectContaining({ label: 'first' }),
        expect.objectContaining({ label: 'tests', description: 'Where that run stopped' }),
      ]);
      expect(pickOptions).toMatchObject({ placeHolder: 'Choose the block to run from' });
      expect(started(services)[2]).toEqual({ resume: { runId: 'run-2', stepId: 'tests' } });

      ui.showQuickPick.mockResolvedValue(undefined);
      await expect(commands.runFromHere()).resolves.toBeUndefined();
      expect(services.runs.start).toHaveBeenCalledTimes(1);
    });

    it('uses the run and block passed as argument', async () => {
      const { services, ui, commands } = setup();
      await commands.runFromHere({ uri: WORKFLOW, runId: 'run-7', stepId: 'first' });
      expect(started(services)).toEqual([
        WORKFLOW,
        undefined,
        { resume: { runId: 'run-7', stepId: 'first' } },
      ]);
      expect(ui.readText).not.toHaveBeenCalled();
    });

    it('warns before reusing results that may be outdated and stops when that is cancelled', async () => {
      const edited = FLOW.replace('echo one', 'echo uno');
      const { services, ui, commands } = setup({
        activeUri: WORKFLOW,
        history: [record('run-2')],
        saved: [savedRun('run-2', FLOW)],
      });
      ui.cursor.mockReturnValue({ text: edited, line: 8, character: 9 });
      await expect(commands.runFromHere()).resolves.toBeUndefined();
      expect(ui.confirm).toHaveBeenCalledWith(
        'Run Build from tests?',
        'first changed since that run, so its result may be outdated.',
        'Run from here',
      );
      expect(services.runs.start).not.toHaveBeenCalled();

      ui.confirm.mockResolvedValue('Run from here');
      await expect(commands.runFromHere()).resolves.toBe('run-1');
      expect(started(services)[2]).toEqual({ resume: { runId: 'run-2', stepId: 'tests' } });
    });

    it('lists blocks without a result and starts at once when nothing needs checking', async () => {
      const added = FLOW.replace(
        '  - id: tests',
        '  - id: lint\n    type: console\n    run: lint\n  - id: tests',
      );
      const { services, ui, commands } = setup({
        history: [record('run-2')],
        saved: [savedRun('run-2', FLOW)],
      });
      ui.readText.mockResolvedValue(added);
      await commands.runFromHere({ uri: WORKFLOW, runId: 'run-2', stepId: 'tests' });
      expect(ui.confirm.mock.calls[0][1]).toBe(
        'lint has no result in that run; expressions that read it get empty values.',
      );
      expect(services.runs.start).not.toHaveBeenCalled();

      ui.readText.mockResolvedValue(FLOW);
      await expect(commands.runFromHere({ uri: WORKFLOW, runId: 'run-2', stepId: 'tests' })).resolves.toBe(
        'run-1',
      );
      expect(ui.confirm).toHaveBeenCalledTimes(1);
      expect(services.runs.start).toHaveBeenCalledTimes(1);
    });

    it('explains that the workflow must run first', async () => {
      const { services, ui, commands } = setup({
        activeUri: WORKFLOW,
        history: [record('run-1', { simulated: true })],
      });
      await expect(commands.runFromHere()).resolves.toBeUndefined();
      expect(ui.showInfo).toHaveBeenCalledWith(
        'build.workflow.yaml has no run to continue. Run it first, then run from a block.',
      );
      expect(services.runs.start).not.toHaveBeenCalled();
    });
  });

  describe('openSimulationFile', () => {
    it('opens the simulation file of the workflow', async () => {
      const { services, commands } = setup({ activeUri: OTHER });
      await commands.openSimulationFile({ uri: WORKFLOW });
      await commands.openSimulationFile();
      expect(services.runs.simulations.open.mock.calls.map(([uri]) => String(uri))).toEqual([
        WORKFLOW,
        OTHER,
      ]);
    });

    it('says why the file could not be opened', async () => {
      const { services, ui, commands } = setup({ activeUri: WORKFLOW });
      services.runs.simulations.open.mockRejectedValue(new Error('The folder is read-only.'));
      await commands.openSimulationFile();
      expect(ui.showError).toHaveBeenCalledWith(
        'Could not open the simulation file: The folder is read-only.',
      );
    });
  });

  describe('runWorkflow', () => {
    it('runs the workflow passed as argument', async () => {
      const { services, ui, commands } = setup({ activeUri: OTHER });
      await expect(commands.runWorkflow(vscode.Uri.parse(WORKFLOW))).resolves.toBe('run-1');
      expect(startedUri(services)).toBe(WORKFLOW);
      expect(ui.showQuickPick).not.toHaveBeenCalled();
    });

    it('accepts the workflow URI as a string', async () => {
      const { services, commands } = setup();
      await commands.runWorkflow(WORKFLOW);
      expect(startedUri(services)).toBe(WORKFLOW);
    });

    it('refuses a file that is not a workflow', async () => {
      const { services, ui, commands } = setup();
      await expect(commands.runWorkflow(vscode.Uri.parse(AGENT))).resolves.toBeUndefined();
      expect(services.runs.start).not.toHaveBeenCalled();
      expect(ui.showError).toHaveBeenCalledWith(
        expect.stringContaining('coder.agent.yaml is not a workflow'),
      );
    });

    it('runs the workflow in the active editor', async () => {
      const { services, ui, commands } = setup({ activeUri: OTHER });
      await commands.runWorkflow();
      expect(startedUri(services)).toBe(OTHER);
      expect(ui.showQuickPick).not.toHaveBeenCalled();
    });

    it('asks which workflow to run when the active editor shows no workflow', async () => {
      const { services, ui, commands } = setup({
        activeUri: AGENT,
        workflows: [summary(WORKFLOW, 'Build'), summary(OTHER, 'Deploy', false)],
      });
      ui.showQuickPick.mockImplementation(async (items: vscode.QuickPickItem[]) => items[1]);
      await commands.runWorkflow();
      const [items, options] = ui.showQuickPick.mock.calls[0];
      expect(items).toMatchObject([
        { label: 'Build', description: '.isarflow/workflows/build.workflow.yaml' },
        { label: 'Deploy', description: 'deploy.workflow.yml', detail: expect.stringContaining('problems') },
      ]);
      expect(options).toMatchObject({ placeHolder: 'Choose a workflow to run' });
      expect(startedUri(services)).toBe(OTHER);
    });

    it('does nothing when the pick is cancelled', async () => {
      const { services, ui, commands } = setup({ workflows: [summary(WORKFLOW, 'Build')] });
      ui.showQuickPick.mockResolvedValue(undefined);
      await expect(commands.runWorkflow()).resolves.toBeUndefined();
      expect(services.runs.start).not.toHaveBeenCalled();
    });

    it('offers to create a workflow when there is none', async () => {
      const { services, ui, commands } = setup();
      ui.showInfo.mockResolvedValue('New workflow');
      await commands.runWorkflow();
      expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('No workflows'), 'New workflow');
      expect(ui.executeCommand).toHaveBeenCalledWith('isarFlow.newWorkflow');
      expect(services.runs.start).not.toHaveBeenCalled();
    });
  });

  describe('cancelRun', () => {
    const build = activeRun('run-a', WORKFLOW, 'Build');
    const deploy = activeRun('run-b', OTHER, 'Deploy');

    it('cancels the run whose id is passed', async () => {
      const { services, commands } = setup({ active: [build, deploy] });
      await commands.cancelRun('run-b');
      expect(services.runs.cancel).toHaveBeenCalledWith('run-b');
      expect(services.runs.cancel).toHaveBeenCalledTimes(1);
    });

    it('accepts { runId }', async () => {
      const { services, commands } = setup({ active: [build] });
      await commands.cancelRun({ runId: 'run-a' });
      expect(services.runs.cancel).toHaveBeenCalledWith('run-a');
    });

    it('cancels the runs of a workflow passed as URI', async () => {
      const { services, commands } = setup({ active: [build, deploy] });
      await commands.cancelRun(vscode.Uri.parse(OTHER));
      expect(services.runs.cancel).toHaveBeenCalledWith('run-b');
      expect(services.runs.cancel).toHaveBeenCalledTimes(1);
    });

    it('says so when the passed run or workflow is not running', async () => {
      const { services, ui, commands } = setup({ active: [build] });
      await commands.cancelRun('run-old');
      await commands.cancelRun(vscode.Uri.parse(OTHER));
      expect(services.runs.cancel).not.toHaveBeenCalled();
      expect(ui.showInfo).toHaveBeenCalledTimes(2);
    });

    it('says so when nothing is running', async () => {
      const { services, ui, commands } = setup();
      await commands.cancelRun();
      expect(ui.showInfo).toHaveBeenCalledWith('No workflow is running.');
      expect(services.runs.cancel).not.toHaveBeenCalled();
    });

    it('stops the only run without asking', async () => {
      const { services, ui, commands } = setup({ active: [build] });
      await commands.cancelRun();
      expect(ui.showQuickPick).not.toHaveBeenCalled();
      expect(services.runs.cancel).toHaveBeenCalledWith('run-a');
    });

    it('asks which run to stop when several are running', async () => {
      const { services, ui, commands } = setup({ active: [build, deploy] });
      ui.showQuickPick.mockImplementation(async (items: vscode.QuickPickItem[]) => items[1]);
      await commands.cancelRun();
      const [items, options] = ui.showQuickPick.mock.calls[0];
      expect(items).toMatchObject([
        { label: 'Build' },
        { label: 'Deploy', description: 'deploy.workflow.yml' },
      ]);
      expect(options).toMatchObject({ placeHolder: 'Choose a run to stop' });
      expect(services.runs.cancel).toHaveBeenCalledWith('run-b');
    });
  });

  describe('openInCanvas', () => {
    it('opens workflows in the canvas and agents in the agent editor', async () => {
      const { ui, commands } = setup();
      await commands.openInCanvas(vscode.Uri.parse(WORKFLOW));
      await commands.openInCanvas(vscode.Uri.parse(AGENT));
      expect(
        ui.executeCommand.mock.calls.map(([command, uri, viewType]) => [command, String(uri), viewType]),
      ).toEqual([
        ['vscode.openWith', WORKFLOW, 'isarFlow.workflowEditor'],
        ['vscode.openWith', AGENT, 'isarFlow.agentEditor'],
      ]);
    });

    it('uses the active editor when no file is passed', async () => {
      const { ui, commands } = setup({ activeUri: AGENT });
      await commands.openInCanvas();
      expect(ui.executeCommand).toHaveBeenCalledWith(
        'vscode.openWith',
        expect.anything(),
        'isarFlow.agentEditor',
      );
    });

    it('refuses other files', async () => {
      const { ui, commands } = setup();
      await commands.openInCanvas(vscode.Uri.parse('file:///ws/notes.yaml'));
      expect(ui.executeCommand).not.toHaveBeenCalled();
      expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining('notes.yaml'));
    });

    it('asks for a workflow when nothing is open', async () => {
      const { ui, commands } = setup({ workflows: [summary(WORKFLOW, 'Build')] });
      ui.showQuickPick.mockImplementation(async (items: vscode.QuickPickItem[]) => items[0]);
      await commands.openInCanvas();
      expect(ui.showQuickPick.mock.calls[0][1]).toMatchObject({ placeHolder: 'Choose a workflow to open' });
      expect(ui.executeCommand).toHaveBeenCalledWith(
        'vscode.openWith',
        expect.anything(),
        'isarFlow.workflowEditor',
      );
    });

    it('reports a file that cannot be opened', async () => {
      const { ui, commands } = setup();
      ui.executeCommand.mockRejectedValue(new Error('File not found'));
      await commands.openInCanvas(vscode.Uri.parse(WORKFLOW));
      expect(ui.showError).toHaveBeenCalledWith('Could not open build.workflow.yaml: File not found');
    });
  });

  describe('openYaml', () => {
    it('opens the file as text beside the current editor', async () => {
      const { ui, commands } = setup({ activeUri: AGENT });
      await commands.openYaml(vscode.Uri.parse(WORKFLOW));
      await commands.openYaml();
      expect(
        ui.executeCommand.mock.calls.map(([command, uri, ...rest]) => [command, String(uri), ...rest]),
      ).toEqual([
        ['vscode.openWith', WORKFLOW, 'default', vscode.ViewColumn.Beside],
        ['vscode.openWith', AGENT, 'default', vscode.ViewColumn.Beside],
      ]);
    });

    it('explains what to do when no file is open', async () => {
      const { ui, commands } = setup();
      await commands.openYaml();
      expect(ui.executeCommand).not.toHaveBeenCalled();
      expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('Open a workflow or agent'));
    });
  });

  it('showLog shows the output channel', () => {
    const { services, commands } = setup();
    commands.showLog();
    expect(services.output.show).toHaveBeenCalled();
  });
});
