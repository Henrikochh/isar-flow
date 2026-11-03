import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSimulationText, parseWorkflowText, type Workflow } from '@isar-flow/core';
import { createSimulationStore, type SimulationStoreDeps } from '../../../src/simulation/simulationStore';
import { FakeDocuments, FakeSimulationFs, FakeWatcher } from './fakes';

const WORKFLOW_PATH = '/ws/.isarflow/workflows/build.workflow.yaml';
const SIM_PATH = '/ws/.isarflow/simulations/build.sim.yaml';
const WORKFLOW_TEXT = `version: 1
name: Build and test
steps:
  - id: build
    type: console
    run: npm run build
  - id: tests
    type: console
    run: npm test
`;
const MOCKS = `# My notes about these mocks
version: 1
blocks:
  # Tests fail once
  tests:
    - exitCode: 1
      output: 1 failed
    - exitCode: 0
`;

function workflowOf(text: string): Workflow {
  const parsed = parseWorkflowText(text);
  if (!parsed.workflow) throw new Error('Test workflow does not parse');
  return parsed.workflow;
}

function setup(options: { folders?: string[]; deps?: Partial<SimulationStoreDeps> } = {}) {
  const fs = new FakeSimulationFs();
  fs.files.set(WORKFLOW_PATH, WORKFLOW_TEXT);
  const documents = new FakeDocuments(fs);
  const watchers: FakeWatcher[] = [];
  const folders = (options.folders ?? ['/ws']).map((f) => vscode.Uri.file(f));
  const store = createSimulationStore({
    fs,
    documents,
    createWatcher: (glob) => {
      const watcher = new FakeWatcher(glob);
      watchers.push(watcher);
      return watcher;
    },
    workspaceFolder: (uri) => folders.find((f) => uri.path.startsWith(`${f.path}/`)),
    ...options.deps,
  });
  const changes: string[] = [];
  store.onDidChange(({ uri }) => changes.push(uri));
  return { fs, documents, watchers, store, changes, workflow: vscode.Uri.file(WORKFLOW_PATH) };
}

const blocksOf = (text: string | undefined) => checkSimulationText(text ?? '', null).file.blocks;

afterEach(() => {
  vi.useRealTimers();
});

describe('simulation store: uriFor', () => {
  it.each([
    ['/ws/.isarflow/workflows/build.workflow.yaml', '/ws/.isarflow/simulations/build.sim.yaml'],
    ['/ws/flows/Review.Workflow.YML', '/ws/.isarflow/simulations/Review.sim.yaml'],
    ['/ws/flows/release.yaml', '/ws/.isarflow/simulations/release.sim.yaml'],
    ['/ws/Makefile', '/ws/.isarflow/simulations/Makefile.sim.yaml'],
    ['/ws/a/deep/folder/build.workflow.yml', '/ws/.isarflow/simulations/build.sim.yaml'],
    ['/second/build.workflow.yaml', '/second/.isarflow/simulations/build.sim.yaml'],
    ['/outside/tools/build.workflow.yaml', '/outside/tools/.isarflow/simulations/build.sim.yaml'],
  ])('puts the mocks of %s in %s', (workflow, expected) => {
    const t = setup({ folders: ['/ws', '/second'] });
    expect(t.store.uriFor(vscode.Uri.file(workflow)).path).toBe(expected);
  });

  it('uses an existing .sim.yml only when there is no .sim.yaml', () => {
    const t = setup();
    t.fs.files.set('/ws/.isarflow/simulations/build.sim.yml', 'version: 1\n');
    expect(t.store.uriFor(t.workflow).path).toBe('/ws/.isarflow/simulations/build.sim.yml');
    t.fs.files.set(SIM_PATH, 'version: 1\n');
    expect(t.store.uriFor(t.workflow).path).toBe(SIM_PATH);
  });
});

describe('simulation store: state and load', () => {
  it('reports a missing file without problems', async () => {
    const t = setup();
    expect(await t.store.state(t.workflow, workflowOf(WORKFLOW_TEXT))).toEqual({
      path: '.isarflow/simulations/build.sim.yaml',
      exists: false,
      file: {},
      diagnostics: [],
    });
    expect(await t.store.load(t.workflow)).toEqual({});
  });

  it('reads and checks the file against the workflow', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, `${MOCKS}  deploy:\n    - exitCode: 0\n`);
    const state = await t.store.state(t.workflow, workflowOf(WORKFLOW_TEXT));
    expect(state.exists).toBe(true);
    expect(state.file.blocks?.tests).toEqual([{ exitCode: 1, output: '1 failed' }, { exitCode: 0 }]);
    expect(state.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'sim-unknown-block', stepId: 'deploy' }),
    ]);
    // Without the workflow only the file itself is checked; warnings never stop a simulation.
    expect((await t.store.state(t.workflow, null)).diagnostics).toEqual([]);
    expect((await t.store.load(t.workflow)).blocks?.deploy).toEqual([{ exitCode: 0 }]);
  });

  it('reports errors and refuses to load a broken file', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, 'version: 1\nblocks:\n  tests:\n    exitCode: 1\n');
    const state = await t.store.state(t.workflow, null);
    expect(state.file).toEqual({});
    expect(state.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    await expect(t.store.load(t.workflow)).rejects.toThrow(
      new Error(
        'Fix .isarflow/simulations/build.sim.yaml before simulating: Use a list of results for "tests", e.g. "- exitCode: 0" (line 3).',
      ),
    );
  });

  it('ends the refusal with one period', async () => {
    const t = setup();
    t.fs.failures.set(SIM_PATH, new Error('Is a directory.'));
    await expect(t.store.load(t.workflow)).rejects.toThrow(
      new Error(
        'Fix .isarflow/simulations/build.sim.yaml before simulating: Could not read .isarflow/simulations/build.sim.yaml: Is a directory.',
      ),
    );
  });

  it('turns read errors into an error diagnostic', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, MOCKS);
    t.fs.failures.set(SIM_PATH, new Error('Permission denied'));
    expect(await t.store.state(t.workflow, null)).toEqual({
      path: '.isarflow/simulations/build.sim.yaml',
      exists: true,
      file: {},
      diagnostics: [
        expect.objectContaining({
          severity: 'error',
          message: 'Could not read .isarflow/simulations/build.sim.yaml: Permission denied',
        }),
      ],
    });
    await expect(t.store.load(t.workflow)).rejects.toThrow(
      'Fix .isarflow/simulations/build.sim.yaml before simulating: Could not read .isarflow/simulations/build.sim.yaml: Permission denied.',
    );
  });

  it('reads unsaved edits of an open editor', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, MOCKS);
    t.documents.add(SIM_PATH, 'version: 1\nblocks:\n  build:\n    - exitCode: 2\n', true);
    expect((await t.store.state(t.workflow, null)).file.blocks).toEqual({ build: [{ exitCode: 2 }] });
    // A saved editor shows the file, also when the file was deleted while it was open.
    t.documents.add(SIM_PATH, MOCKS, false);
    t.fs.files.delete(SIM_PATH);
    expect((await t.store.state(t.workflow, null)).exists).toBe(false);
  });

  it('names the file by its full path outside all workspace folders', async () => {
    const t = setup({ folders: [] });
    const state = await t.store.state(t.workflow, null);
    expect(state.path).toBe(
      vscode.Uri.file('/ws/.isarflow/workflows/.isarflow/simulations/build.sim.yaml').fsPath,
    );
  });
});

describe('simulation store: setBlock and renameBlock', () => {
  it('creates the file from the template with the first mocks', async () => {
    const t = setup();
    await t.store.setBlock(t.workflow, 'tests', [{ exitCode: 1, output: '1 failed' }]);
    const text = t.fs.files.get(SIM_PATH) ?? '';
    expect(text).toMatch(/^#/);
    expect(text).toContain('Build and test');
    expect(blocksOf(text)).toEqual({ tests: [{ exitCode: 1, output: '1 failed' }] });
    expect(t.fs.writes).toHaveLength(1);
  });

  it('names a new file after the workflow file when the workflow has no name', async () => {
    const t = setup();
    t.fs.files.set(WORKFLOW_PATH, 'version: 1\nsteps: []\n');
    await t.store.setBlock(t.workflow, 'tests', [{ exitCode: 0 }]);
    expect(t.fs.files.get(SIM_PATH)).toContain('build.workflow.yaml');
  });

  it('replaces and removes mocks and keeps comments and other blocks', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, MOCKS);
    await t.store.setBlock(t.workflow, 'build', [{ exitCode: 2, output: 'compile error' }]);
    await t.store.setBlock(t.workflow, 'tests', [{ exitCode: 0 }]);
    let text = t.fs.files.get(SIM_PATH) ?? '';
    expect(text).toContain('# My notes about these mocks');
    expect(blocksOf(text)).toEqual({
      tests: [{ exitCode: 0 }],
      build: [{ exitCode: 2, output: 'compile error' }],
    });

    await t.store.setBlock(t.workflow, 'build', null);
    await t.store.setBlock(t.workflow, 'tests', []);
    text = t.fs.files.get(SIM_PATH) ?? '';
    expect(text).toContain('# My notes about these mocks');
    expect(blocksOf(text) ?? {}).toEqual({});
  });

  it('does not create a file to remove mocks', async () => {
    const t = setup();
    await t.store.setBlock(t.workflow, 'tests', null);
    expect(t.fs.writes).toEqual([]);
  });

  it('writes nothing when the file has YAML errors', async () => {
    const t = setup();
    const broken = 'version: 1\nblocks: [oops\n';
    t.fs.files.set(SIM_PATH, broken);
    await expect(t.store.setBlock(t.workflow, 'tests', [{ exitCode: 0 }])).rejects.toThrow(
      /^The simulation file can't be read: .+\. Fix it in the file first\.$/,
    );
    expect(t.fs.files.get(SIM_PATH)).toBe(broken);
    expect(t.fs.writes).toEqual([]);
  });

  it('propagates read errors', async () => {
    const t = setup();
    t.fs.failures.set(SIM_PATH, new Error('Permission denied'));
    await expect(t.store.setBlock(t.workflow, 'tests', [{ exitCode: 0 }])).rejects.toThrow(
      'Permission denied',
    );
    expect(t.fs.writes).toEqual([]);
  });

  it('edits an open editor and saves it when it had no unsaved edits', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, MOCKS);
    const doc = t.documents.add(SIM_PATH, MOCKS);
    await t.store.setBlock(t.workflow, 'build', [{ exitCode: 0 }]);
    expect(t.documents.edits).toHaveLength(1);
    expect(doc.saves).toBe(1);
    expect(blocksOf(t.fs.files.get(SIM_PATH))?.build).toEqual([{ exitCode: 0 }]);
    expect(t.fs.writes).toEqual([]);
  });

  it('edits the unsaved text of an open editor and leaves it unsaved', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, MOCKS);
    const unsaved = `${MOCKS}  build:\n    - exitCode: 3\n`;
    const doc = t.documents.add(SIM_PATH, unsaved, true);
    await t.store.setBlock(t.workflow, 'tests', null);
    expect(doc.saves).toBe(0);
    expect(blocksOf(doc.text)).toEqual({ build: [{ exitCode: 3 }] });
    expect(t.fs.files.get(SIM_PATH)).toBe(MOCKS);
  });

  it('fails when the editor refuses the edit or the save', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, MOCKS);
    const doc = t.documents.add(SIM_PATH, MOCKS);
    t.documents.acceptEdits = false;
    await expect(t.store.setBlock(t.workflow, 'build', [{ exitCode: 0 }])).rejects.toThrow(
      'Could not change .isarflow/simulations/build.sim.yaml. Close its editor and try again.',
    );
    t.documents.acceptEdits = true;
    doc.saveResult = false;
    await expect(t.store.setBlock(t.workflow, 'build', [{ exitCode: 0 }])).rejects.toThrow(
      'Could not save .isarflow/simulations/build.sim.yaml. Save it in its editor.',
    );
  });

  it('runs writes to the same file one after the other', async () => {
    const t = setup();
    let open = () => undefined as void;
    t.fs.gate = new Promise<void>((resolve) => (open = resolve));
    const writes = [
      t.store.setBlock(t.workflow, 'build', [{ exitCode: 0 }]),
      t.store.setBlock(t.workflow, 'tests', [{ exitCode: 1 }]),
      t.store.setBlock(t.workflow, 'build', [{ exitCode: 2 }]),
    ];
    open();
    await Promise.all(writes);
    expect(t.fs.writes).toHaveLength(3);
    expect(blocksOf(t.fs.files.get(SIM_PATH))).toEqual({
      build: [{ exitCode: 2 }],
      tests: [{ exitCode: 1 }],
    });
  });

  it('keeps the queue going after a failed write', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, 'blocks: [oops\n');
    const failed = t.store.setBlock(t.workflow, 'build', [{ exitCode: 0 }]);
    const fixed = failed.catch(() => t.fs.files.set(SIM_PATH, MOCKS));
    await expect(failed).rejects.toThrow();
    await fixed;
    await t.store.setBlock(t.workflow, 'build', [{ exitCode: 0 }]);
    expect(blocksOf(t.fs.files.get(SIM_PATH))?.build).toEqual([{ exitCode: 0 }]);
  });

  it('renames the mocks of a block in place', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, MOCKS);
    await t.store.renameBlock(t.workflow, 'tests', 'unit_tests');
    const text = t.fs.files.get(SIM_PATH) ?? '';
    expect(text).toContain('# Tests fail once');
    expect(Object.keys(blocksOf(text) ?? {})).toEqual(['unit_tests']);
  });

  it('renames nothing without a file or without mocks for the block', async () => {
    const t = setup();
    await t.store.renameBlock(t.workflow, 'tests', 'unit_tests');
    expect(t.fs.writes).toEqual([]);
    t.fs.files.set(SIM_PATH, MOCKS);
    await t.store.renameBlock(t.workflow, 'build', 'compile');
    expect(t.fs.writes).toEqual([]);
  });
});

describe('simulation store: open', () => {
  it('creates a missing file from the template and shows it', async () => {
    const t = setup();
    await t.store.open(t.workflow);
    const text = t.fs.files.get(SIM_PATH) ?? '';
    expect(checkSimulationText(text, null)).toEqual({ file: expect.any(Object), diagnostics: [] });
    expect(text).toContain('Build and test');
    expect(t.documents.shown.map((u) => u.path)).toEqual([SIM_PATH]);
  });

  it('shows an existing file or open editor without writing', async () => {
    const t = setup();
    t.fs.files.set(SIM_PATH, MOCKS);
    await t.store.open(t.workflow);
    t.fs.files.delete(SIM_PATH);
    t.documents.add(SIM_PATH, MOCKS, true);
    await t.store.open(t.workflow);
    expect(t.fs.writes).toEqual([]);
    expect(t.documents.shown).toHaveLength(2);
  });
});

describe('simulation store: change events', () => {
  it('watches every simulation file and reports changes once per file after 150 ms', async () => {
    vi.useFakeTimers();
    const t = setup();
    const [watcher] = t.watchers;
    expect(watcher.glob).toBe('**/.isarflow/simulations/*.sim.{yaml,yml}');
    const sim = vscode.Uri.file(SIM_PATH);
    const other = vscode.Uri.file('/ws/.isarflow/simulations/other.sim.yml');

    watcher.created.fire(sim);
    watcher.changed.fire(sim);
    t.documents.fireChange(sim);
    watcher.deleted.fire(other);
    await vi.advanceTimersByTimeAsync(149);
    expect(t.changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.changes.sort()).toEqual([other.toString(), sim.toString()].sort());

    t.documents.fireChange(sim);
    await vi.advanceTimersByTimeAsync(150);
    expect(t.changes).toHaveLength(3);
  });

  it('ignores editor changes of other files', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.documents.fireChange(vscode.Uri.file(WORKFLOW_PATH));
    t.documents.fireChange(vscode.Uri.file('/ws/notes.sim.yaml'));
    await vi.advanceTimersByTimeAsync(500);
    expect(t.changes).toEqual([]);
  });

  it('stops watching on dispose', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.watchers[0].changed.fire(vscode.Uri.file(SIM_PATH));
    t.store.dispose();
    await vi.advanceTimersByTimeAsync(500);
    t.documents.fireChange(vscode.Uri.file(SIM_PATH));
    await vi.advanceTimersByTimeAsync(500);
    expect(t.changes).toEqual([]);
    expect(t.watchers[0].disposed).toBe(true);
  });
});
