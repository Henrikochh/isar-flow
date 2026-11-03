import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVscodeWatcher,
  sameUri,
  vscodeSimulationDocuments,
  vscodeSimulationFs,
} from '../../../src/simulation/simulationIo';
import { isSimulationPath, simulationName } from '../../../src/simulation/simulationPaths';

const SIM = vscode.Uri.file('/ws/.isarflow/simulations/build.sim.yaml');

/** The part of vscode.TextDocument the adapters read. */
function fakeTextDocument(uri: vscode.Uri, text: string) {
  return {
    uri,
    isDirty: false,
    getText: () => text,
    positionAt: (offset: number) => new vscode.Position(0, offset),
    save: async () => true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(vscode.workspace, { textDocuments: [] });
});

describe('simulation paths', () => {
  it('recognizes simulation files in any .isarflow/simulations folder', () => {
    expect(isSimulationPath('/ws/.isarflow/simulations/build.sim.yaml')).toBe(true);
    expect(isSimulationPath('/ws/sub/.isarflow/simulations/Build.SIM.YML')).toBe(true);
    expect(isSimulationPath('/ws/.isarflow/simulations/nested/build.sim.yaml')).toBe(false);
    expect(isSimulationPath('/ws/.isarflow/workflows/build.workflow.yaml')).toBe(false);
  });

  it.each([
    ['build.workflow.yaml', 'build'],
    ['build.WORKFLOW.yml', 'build'],
    ['.workflow.yaml', '.workflow'],
    ['notes.txt', 'notes'],
    ['README', 'README'],
  ])('names the mocks of %s after %s', (file, name) => {
    expect(simulationName(file)).toBe(name);
  });
});

describe('vscodeSimulationFs', () => {
  it('reads text and treats a missing file as undefined', async () => {
    const read = vi.spyOn(vscode.workspace.fs, 'readFile');
    read.mockResolvedValueOnce(new TextEncoder().encode('﻿version: 1\n'));
    expect(await vscodeSimulationFs.read(SIM)).toBe('version: 1\n');
    read.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'FileNotFound' }));
    expect(await vscodeSimulationFs.read(SIM)).toBeUndefined();
    read.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'NoPermissions' }));
    await expect(vscodeSimulationFs.read(SIM)).rejects.toThrow('denied');
    read.mockRejectedValueOnce('odd');
    await expect(vscodeSimulationFs.read(SIM)).rejects.toBe('odd');
  });

  it('creates the folder before it writes', async () => {
    const order: string[] = [];
    vi.spyOn(vscode.workspace.fs, 'createDirectory').mockImplementation(async (uri: vscode.Uri) => {
      order.push(`mkdir ${uri.path}`);
    });
    vi.spyOn(vscode.workspace.fs, 'writeFile').mockImplementation(
      async (uri: vscode.Uri, bytes: Uint8Array) => {
        order.push(`write ${uri.path} ${new TextDecoder().decode(bytes)}`);
      },
    );
    await vscodeSimulationFs.write(SIM, 'version: 1\n');
    expect(order).toEqual([
      'mkdir /ws/.isarflow/simulations',
      'write /ws/.isarflow/simulations/build.sim.yaml version: 1\n',
    ]);
  });

  it('checks existence on disk for file URIs only', () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'isar-sim-'));
    try {
      const file = nodePath.join(dir, 'build.sim.yml');
      nodeFs.writeFileSync(file, 'version: 1\n');
      expect(vscodeSimulationFs.exists(vscode.Uri.file(file))).toBe(true);
      expect(vscodeSimulationFs.exists(vscode.Uri.file(nodePath.join(dir, 'other.sim.yml')))).toBe(false);
      expect(vscodeSimulationFs.exists(vscode.Uri.parse('untitled:/build.sim.yml'))).toBe(false);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('vscodeSimulationDocuments', () => {
  it('finds open documents and replaces their whole text with one edit', async () => {
    const doc = fakeTextDocument(SIM, 'old text');
    Object.assign(vscode.workspace, { textDocuments: [doc] });
    expect(vscodeSimulationDocuments.find(vscode.Uri.file(SIM.path))).toBe(doc);
    expect(vscodeSimulationDocuments.find(vscode.Uri.file('/ws/other.sim.yaml'))).toBeUndefined();

    const apply = vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);
    expect(await vscodeSimulationDocuments.replaceAll(SIM, 'new text')).toBe(true);
    const [edit] = apply.mock.calls[0] as unknown as [vscode.WorkspaceEdit & { edits: unknown[] }];
    expect(edit.edits).toEqual([
      {
        kind: 'replace',
        uri: SIM,
        range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 8)),
        text: 'new text',
      },
    ]);
    expect(await vscodeSimulationDocuments.replaceAll(vscode.Uri.file('/ws/closed.sim.yaml'), 'x')).toBe(
      false,
    );
  });

  it('reports text changes and shows files beside the active editor', async () => {
    const listeners: ((e: { document: { uri: vscode.Uri } }) => void)[] = [];
    Object.assign(vscode.workspace, {
      onDidChangeTextDocument: (listener: (e: { document: { uri: vscode.Uri } }) => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    });
    const seen: string[] = [];
    vscodeSimulationDocuments.onDidChange((uri) => seen.push(uri.path));
    listeners[0]({ document: { uri: SIM } });
    expect(seen).toEqual([SIM.path]);

    const show = vi.spyOn(vscode.window, 'showTextDocument');
    await vscodeSimulationDocuments.show(SIM);
    expect(show).toHaveBeenCalledWith(SIM, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  });

  it('compares URIs like the file system', () => {
    expect(sameUri(SIM, vscode.Uri.file(SIM.path))).toBe(true);
    expect(sameUri(SIM, vscode.Uri.parse('untitled:/ws/.isarflow/simulations/build.sim.yaml'))).toBe(false);
  });

  it('creates a file system watcher for a glob', () => {
    const create = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');
    createVscodeWatcher('**/*.sim.yaml');
    expect(create).toHaveBeenCalledWith('**/*.sim.yaml');
  });
});
