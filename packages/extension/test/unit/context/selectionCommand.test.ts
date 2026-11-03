import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { WorkflowSummary } from '@isar-flow/core';
import {
  createSelectionCommand,
  registerSelectionCommand,
  type SelectionCommandServices,
  type SelectionCommandUi,
} from '../../../src/context/selectionCommand';
import type { Services } from '../../../src/contracts';
import { fakeEditor, patchWindow } from './fakes';

const ROOT_A = vscode.Uri.file('/ws');
const ROOT_B = vscode.Uri.file('/other');
const EXPLAIN = 'file:///ws/.isarflow/workflows/explain.workflow.yaml';
const BUILD = 'file:///ws/.isarflow/workflows/build.workflow.yaml';
const DOCS = 'file:///other/.isarflow/workflows/docs.workflow.yaml';
const SOURCE = vscode.Uri.file('/ws/src/app.ts');
const TEXT = 'const a = 1;\nconst b = 2;';

function summary(uri: string, name: string, extra: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    uri,
    name,
    relativePath: uri.replace(/^file:\/\/\/(ws|other)\//, ''),
    valid: true,
    stepCount: 1,
    ...extra,
  };
}

type Item = vscode.QuickPickItem & { uri?: string };

interface SetupOptions {
  workflows?: WorkflowSummary[];
  editor?: vscode.TextEditor;
  activeDocument?: vscode.Uri;
  pick?: (items: Item[]) => Item | undefined;
}

function setup(options: SetupOptions = {}) {
  const editor =
    'editor' in options ? options.editor : fakeEditor(SOURCE, TEXT, [{ from: [1, 6], to: [1, 7] }]);
  const services = {
    workflows: {
      list: vi.fn(() => options.workflows ?? [summary(EXPLAIN, 'Explain', { usesEditor: true })]),
    },
    runs: { start: vi.fn<SelectionCommandServices['runs']['start']>(async () => 'run-1') },
  };
  let shownItems: Item[] = [];
  const ui = {
    currentEditor: vi.fn(() => editor),
    activeDocument: vi.fn(() => options.activeDocument ?? editor?.document.uri),
    workspaceFolderOf: vi.fn((uri: vscode.Uri) =>
      uri.path.startsWith('/other/')
        ? ROOT_B.fsPath
        : uri.path.startsWith('/ws/')
          ? ROOT_A.fsPath
          : undefined,
    ),
    firstFolder: vi.fn(() => ROOT_A.fsPath),
    showQuickPick: vi.fn(),
    showInfo: vi.fn(
      async (_message: string, ..._actions: string[]): Promise<string | undefined> => undefined,
    ),
    showError: vi.fn(async (_message: string) => undefined),
    executeCommand: vi.fn(async () => undefined),
  } satisfies SelectionCommandUi;
  ui.showQuickPick.mockImplementation(async (items: readonly Item[]) => {
    shownItems = [...items];
    return options.pick ? options.pick(shownItems) : shownItems.find((item) => item.uri);
  });
  const run = createSelectionCommand(services, ui);
  return { services, ui, run, items: () => shownItems };
}

describe('Run workflow on selection', () => {
  it('runs the picked workflow on the selection with origin selection', async () => {
    const { run, services, ui } = setup();
    expect(await run()).toBe('run-1');
    expect(ui.showQuickPick).toHaveBeenCalledWith(expect.any(Array), {
      placeHolder: 'Run a workflow on the selection',
      matchOnDescription: true,
    });
    expect(services.runs.start).toHaveBeenCalledWith(vscode.Uri.parse(EXPLAIN), undefined, {
      origin: { kind: 'selection' },
      editor: { selection: 'b', file: 'src/app.ts', language: 'typescript', line: 2 },
    });
    expect(ui.executeCommand).not.toHaveBeenCalled();
  });

  it('lists workflows that use editor values first', async () => {
    const { run, items } = setup({
      workflows: [
        summary(BUILD, 'Build', { description: 'Builds the app' }),
        summary(EXPLAIN, 'Explain', { usesEditor: true, description: 'Explains the selected code' }),
        summary(DOCS, 'Docs', { valid: false, description: 'Writes docs' }),
      ],
      pick: () => undefined,
    });
    await run();
    expect(items()).toEqual([
      { label: 'Use the selection', kind: vscode.QuickPickItemKind.Separator },
      {
        label: 'Explain',
        description: '.isarflow/workflows/explain.workflow.yaml',
        detail: 'Explains the selected code',
        uri: EXPLAIN,
      },
      { label: 'Other workflows', kind: vscode.QuickPickItemKind.Separator },
      {
        label: 'Build',
        description: '.isarflow/workflows/build.workflow.yaml',
        detail: 'Builds the app',
        uri: BUILD,
      },
      {
        label: 'Docs',
        description: '.isarflow/workflows/docs.workflow.yaml',
        detail: '$(warning) Has problems',
        uri: DOCS,
      },
    ]);
  });

  it('shows no group headers when no workflow uses editor values', async () => {
    const { run, items } = setup({ workflows: [summary(BUILD, 'Build')], pick: () => undefined });
    await run();
    expect(items()).toEqual([
      { label: 'Build', description: '.isarflow/workflows/build.workflow.yaml', uri: BUILD },
    ]);
  });

  it('says when nothing is selected', async () => {
    const editor = fakeEditor(SOURCE, TEXT, [{ from: [0, 3], to: [0, 3] }]);
    const { run, ui, services } = setup({ editor });
    await run();
    expect(ui.showQuickPick.mock.calls[0][1].placeHolder).toBe(
      'Run a workflow (nothing selected: editor.selection is empty)',
    );
    expect(services.runs.start.mock.calls[0][2]?.editor).toEqual({
      selection: '',
      file: 'src/app.ts',
      language: 'typescript',
      line: 1,
    });
  });

  it('keeps the selection it saw before the QuickPick opened', async () => {
    const editor = fakeEditor(SOURCE, TEXT, [{ from: [0, 6], to: [0, 7] }]);
    const live = editor as unknown as { selections: vscode.Selection[] };
    const { run, services } = setup({
      editor,
      pick: (items) => {
        // The user clicks elsewhere while the QuickPick is open.
        live.selections = [];
        return items.find((item) => item.uri);
      },
    });
    await run();
    expect(services.runs.start.mock.calls[0][2]?.editor?.selection).toBe('a');
  });

  it("makes the file relative to the chosen workflow's folder", async () => {
    const { run, services } = setup({ workflows: [summary(DOCS, 'Docs')] });
    await run();
    expect(services.runs.start.mock.calls[0][2]?.editor?.file).toBe(SOURCE.fsPath);
  });

  it('uses the first folder for workflows outside all folders', async () => {
    const outside = 'file:///tmp/loose.workflow.yaml';
    const { run, services, ui } = setup({ workflows: [summary(outside, 'Loose')] });
    await run();
    expect(ui.firstFolder).toHaveBeenCalled();
    expect(services.runs.start.mock.calls[0][2]?.editor?.file).toBe('src/app.ts');
  });

  it('needs a text editor', async () => {
    const { run, ui, services } = setup({ editor: undefined });
    expect(await run()).toBeUndefined();
    expect(ui.showInfo).toHaveBeenCalledWith('Open a file and select some text, then run a workflow on it.');
    expect(ui.showQuickPick).not.toHaveBeenCalled();
    expect(services.runs.start).not.toHaveBeenCalled();
  });

  it('offers to create a workflow when there is none', async () => {
    const { run, ui, services } = setup({ workflows: [] });
    ui.showInfo.mockResolvedValueOnce('New workflow');
    expect(await run()).toBeUndefined();
    expect(ui.showInfo).toHaveBeenCalledWith('No workflows yet.', 'New workflow');
    expect(ui.executeCommand).toHaveBeenCalledWith('isarFlow.newWorkflow');
    expect(services.runs.start).not.toHaveBeenCalled();
  });

  it('does nothing when the QuickPick is closed', async () => {
    const { run, services } = setup({ pick: () => undefined });
    expect(await run()).toBeUndefined();
    expect(services.runs.start).not.toHaveBeenCalled();
  });

  it('returns undefined when the run manager refuses the start', async () => {
    const { run, services } = setup();
    services.runs.start.mockResolvedValueOnce(undefined);
    expect(await run()).toBeUndefined();
  });

  describe('with a workflow argument', () => {
    it('skips the QuickPick', async () => {
      const { run, ui, services } = setup({ workflows: [] });
      expect(await run(vscode.Uri.parse(DOCS))).toBe('run-1');
      expect(ui.showQuickPick).not.toHaveBeenCalled();
      expect(services.workflows.list).not.toHaveBeenCalled();
      expect(services.runs.start).toHaveBeenCalledWith(vscode.Uri.parse(DOCS), undefined, {
        origin: { kind: 'selection' },
        editor: { selection: 'b', file: SOURCE.fsPath, language: 'typescript', line: 2 },
      });
    });

    it('accepts the URI or the path as a string', async () => {
      const { run, ui, services } = setup();
      await run(BUILD);
      await run('/ws/.isarflow/workflows/build.workflow.yaml');
      expect(ui.showQuickPick).not.toHaveBeenCalled();
      expect(services.runs.start.mock.calls.map(([uri]) => uri.toString())).toEqual([BUILD, BUILD]);
    });

    it("ignores the editor's own file that the context menu passes", async () => {
      const { run, ui } = setup();
      await run(SOURCE);
      expect(ui.showQuickPick).toHaveBeenCalled();
    });

    it('ignores arguments that are not workflows', async () => {
      const { run, ui } = setup();
      await run(vscode.Uri.file('/ws/readme.md'));
      await run({ groupId: 1 });
      expect(ui.showQuickPick).toHaveBeenCalledTimes(2);
    });

    it('still needs a text editor', async () => {
      const { run, services } = setup({ editor: undefined });
      await run(vscode.Uri.parse(EXPLAIN));
      expect(services.runs.start).not.toHaveBeenCalled();
    });

    it('ignores a workflow file that is the active document', async () => {
      const { run, ui } = setup({ activeDocument: vscode.Uri.parse(EXPLAIN) });
      await run(vscode.Uri.parse(EXPLAIN));
      expect(ui.showQuickPick).toHaveBeenCalled();
    });
  });
});

describe('registerSelectionCommand', () => {
  let window: ReturnType<typeof patchWindow> | undefined;
  afterEach(() => {
    window?.restore();
    vi.restoreAllMocks();
  });

  function register() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, handler) => {
      handlers.set(id, handler);
      return { dispose: () => handlers.delete(id) };
    });
    const services = {
      workflows: { list: () => [summary(EXPLAIN, 'Explain')] },
      runs: { start: vi.fn(async () => 'run-9') },
      output: { error: vi.fn() },
    };
    const disposable = registerSelectionCommand(services as unknown as Services);
    return { handlers, services, disposable };
  }

  it('registers isarFlow.runWorkflowOnSelection with the window as its UI', async () => {
    window = patchWindow(fakeEditor(SOURCE, TEXT, [{ from: [0, 0], to: [0, 5] }]), []);
    vi.spyOn(vscode.workspace, 'getWorkspaceFolder').mockImplementation((uri) =>
      uri.path.startsWith('/ws/') ? { uri: ROOT_A, name: 'ws', index: 0 } : undefined,
    );
    const { handlers, services, disposable } = register();
    const handler = handlers.get('isarFlow.runWorkflowOnSelection');
    expect(handler).toBeDefined();
    expect(await handler?.(vscode.Uri.parse(EXPLAIN))).toBe('run-9');
    expect(services.runs.start).toHaveBeenCalledWith(vscode.Uri.parse(EXPLAIN), undefined, {
      origin: { kind: 'selection' },
      editor: { selection: 'const', file: 'src/app.ts', language: 'typescript', line: 1 },
    });
    disposable.dispose();
    expect(handlers.size).toBe(0);
    expect(window.listeners).toHaveLength(0);
  });

  it('shows unexpected errors and logs them', async () => {
    window = patchWindow(fakeEditor(SOURCE, TEXT), []);
    const shown = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    const { handlers, services, disposable } = register();
    services.runs.start.mockRejectedValueOnce(new Error('boom'));
    expect(
      await handlers.get('isarFlow.runWorkflowOnSelection')?.(vscode.Uri.parse(EXPLAIN)),
    ).toBeUndefined();
    expect(shown).toHaveBeenCalledWith('Could not run the workflow on the selection: boom');
    expect(services.output.error).toHaveBeenCalledWith(
      expect.stringContaining('Run workflow on selection failed'),
    );
    disposable.dispose();
  });
});
