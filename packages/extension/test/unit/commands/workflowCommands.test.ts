import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { RunView, WorkflowSummary } from '@isar-flow/core';
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

function setup(options: { workflows?: WorkflowSummary[]; active?: ActiveRun[]; activeUri?: string } = {}) {
  const runs = options.active ?? [];
  const services: WorkflowCommandServices = {
    workflows: { list: vi.fn(() => options.workflows ?? []) },
    runs: {
      start: vi.fn(async () => 'run-1'),
      cancel: vi.fn(),
      active: vi.fn((uri?: string) => runs.filter((r) => uri === undefined || r.workflowUri === uri)),
    },
    output: { show: vi.fn() },
  };
  const ui = {
    activeUri: vi.fn(() => (options.activeUri ? vscode.Uri.parse(options.activeUri) : undefined)),
    showQuickPick: vi.fn(),
    showInfo: vi.fn(async () => undefined as string | undefined),
    showError: vi.fn(async () => undefined),
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
        'isarFlow.openYaml',
        'isarFlow.runWorkflow',
        'isarFlow.showLog',
      ].sort(),
    );
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
