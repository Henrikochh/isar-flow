import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createVscodeWorkspaceFiles, vscodeReviewUi } from '../../../src/safety/workspaceFiles';
import { removeTempDirs, tempDir } from './gitRepo';

// The unit-test stub of vscode has no TextEdit / EndOfLine; these tests add what the module uses.
vi.mock('vscode', async (importOriginal) => {
  const stub = await importOriginal<Record<string, unknown>>();
  return {
    ...stub,
    EndOfLine: { LF: 1, CRLF: 2 },
    TextEdit: {
      replace: (range: unknown, newText: string) => ({ kind: 'replace', range, newText }),
      setEndOfLine: (eol: number) => ({ kind: 'eol', eol }),
    },
  };
});

interface FakeDoc {
  uri: vscode.Uri;
  isDirty: boolean;
  eol: number;
  text: string;
  getText(): string;
  positionAt(offset: number): vscode.Position;
  save(): Promise<boolean>;
}

const workspace = vscode.workspace as unknown as Record<string, unknown> & { textDocuments: unknown[] };
const original = { ...workspace, fs: { ...(vscode.workspace.fs as object) } };

function fakeDoc(file: string, text: string, isDirty = false): FakeDoc {
  return {
    uri: vscode.Uri.file(file),
    isDirty,
    eol: 1,
    text,
    getText() {
      return this.text;
    },
    positionAt: (offset) => new vscode.Position(0, offset),
    save: async () => true,
  };
}

afterAll(removeTempDirs);

describe('VS Code workspace files', () => {
  let dir: string;
  let edits: { set?: unknown[]; deleted?: string }[];
  let applyResult: boolean;

  beforeEach(() => {
    dir = tempDir('isar-files-');
    edits = [];
    applyResult = true;
    Object.assign(workspace, {
      textDocuments: [],
      fs: {
        ...original.fs,
        writeFile: async (uri: vscode.Uri, bytes: Uint8Array) => fs.writeFileSync(uri.fsPath, bytes),
      },
      applyEdit: async (edit: { entries?: unknown; sets?: unknown[]; deleted?: string }) => {
        edits.push({ ...(edit.sets && { set: edit.sets }), ...(edit.deleted && { deleted: edit.deleted }) });
        return applyResult;
      },
    });
    vi.spyOn(vscode.WorkspaceEdit.prototype, 'deleteFile').mockImplementation(function (
      this: { deleted?: string },
      uri: vscode.Uri,
    ) {
      this.deleted = uri.fsPath;
    });
    Object.assign(vscode.WorkspaceEdit.prototype, {
      set(this: { sets?: unknown[] }, _uri: vscode.Uri, list: unknown[]) {
        this.sets = list;
      },
    });
  });

  afterEach(() => {
    Object.assign(workspace, original);
    vi.restoreAllMocks();
  });

  it('reads unsaved editor text before the file on disk', async () => {
    const files = createVscodeWorkspaceFiles();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'on disk');
    expect(Buffer.from((await files.current(file)) ?? []).toString()).toBe('on disk');
    workspace.textDocuments.push(fakeDoc(file, 'typed', true));
    expect(Buffer.from((await files.current(file)) ?? []).toString()).toBe('typed');
    expect(await files.current(path.join(dir, 'missing.txt'))).toBeUndefined();
  });

  it('replaces text through the editor, line endings included, and writes the bytes when that fails', async () => {
    const files = createVscodeWorkspaceFiles();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'new\n');
    const doc = fakeDoc(file, 'new\n');
    workspace.openTextDocument = async () => doc;
    // VS Code applies the edit and saves: here the edit "applies" by writing the file.
    workspace.applyEdit = async (edit: { sets?: { newText?: string }[] }) => {
      edits.push({ set: edit.sets });
      fs.writeFileSync(
        file,
        (edit.sets?.[0]?.newText ?? '').replace(/\n/g, '\r\n').replace(/\r\r\n/g, '\r\n'),
      );
      return true;
    };
    await files.write(file, new TextEncoder().encode('old\r\nlines\r\n'));
    expect(edits[0].set).toEqual([
      { kind: 'replace', range: expect.anything(), newText: 'old\r\nlines\r\n' },
      { kind: 'eol', eol: 2 },
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe('old\r\nlines\r\n');

    // A refused edit (or one that ends with other bytes) falls back to writing the bytes.
    workspace.applyEdit = async () => false;
    await files.write(file, new TextEncoder().encode('restored\n'));
    expect(fs.readFileSync(file, 'utf8')).toBe('restored\n');
  });

  it('writes binary, mixed and new files as bytes, creating folders', async () => {
    const files = createVscodeWorkspaceFiles();
    workspace.openTextDocument = vi.fn();
    const binary = path.join(dir, 'img.bin');
    fs.writeFileSync(binary, 'x');
    await files.write(binary, new Uint8Array([0, 1, 2]));
    expect([...fs.readFileSync(binary)]).toEqual([0, 1, 2]);
    const mixed = path.join(dir, 'mixed.txt');
    fs.writeFileSync(mixed, 'x');
    await files.write(mixed, new TextEncoder().encode('a\r\nb\nc'));
    expect(fs.readFileSync(mixed, 'utf8')).toBe('a\r\nb\nc');
    const created = path.join(dir, 'deep', 'er', 'new.txt');
    await files.write(created, new TextEncoder().encode('hi\n'));
    expect(fs.readFileSync(created, 'utf8')).toBe('hi\n');
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('deletes through a workspace edit, or directly when VS Code refuses', async () => {
    const files = createVscodeWorkspaceFiles();
    const file = path.join(dir, 'gone.txt');
    fs.writeFileSync(file, 'x');
    await files.delete(file);
    expect(edits).toEqual([{ deleted: vscode.Uri.file(file).fsPath }]);
    expect(fs.existsSync(file)).toBe(true);

    applyResult = false;
    await files.delete(file);
    expect(fs.existsSync(file)).toBe(false);
    await files.delete(file);
    expect(edits).toHaveLength(2);
  });

  it('asks in a modal dialog and passes commands on', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Revert anyway' as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    expect(await vscodeReviewUi.ask('a.txt changed after the run.', 'Details', ['Revert anyway'])).toBe(
      'Revert anyway',
    );
    expect(warn).toHaveBeenCalledWith(
      'a.txt changed after the run.',
      { modal: true, detail: 'Details' },
      'Revert anyway',
    );
    await vscodeReviewUi.ask('Short', undefined, ['Replace']);
    expect(warn).toHaveBeenLastCalledWith('Short', { modal: true }, 'Replace');
    await vscodeReviewUi.showInfo("Binary files can't be compared.", 'Open file');
    expect(info).toHaveBeenCalledWith("Binary files can't be compared.", 'Open file');
    await vscodeReviewUi.executeCommand('vscode.diff', 1, 2);
    expect(run).toHaveBeenCalledWith('vscode.diff', 1, 2);
  });
});
