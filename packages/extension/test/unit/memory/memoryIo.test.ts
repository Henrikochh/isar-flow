import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { MEMORY_NOT_TEXT } from '@isar-flow/core';
import {
  isMemoryUri,
  memoryFilePath,
  nodeMemoryFs,
  vscodeMemoryDocuments,
  vscodeMemoryWorkspace,
} from '../../../src/memory/memoryIo';

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isar-memory-io-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory file paths', () => {
  it('puts the file in .isarflow of the root and recognizes it in any folder', () => {
    expect(memoryFilePath(path.join('/ws', 'a'))).toBe(path.join('/ws', 'a', '.isarflow', 'memory.md'));
    expect(isMemoryUri(vscode.Uri.file('/ws/a/.isarflow/memory.md'))).toBe(true);
    expect(isMemoryUri(vscode.Uri.file('/ws/a/.IsarFlow/Memory.md'))).toBe(true);
    expect(isMemoryUri(vscode.Uri.file('/ws/a/memory.md'))).toBe(false);
  });
});

describe('nodeMemoryFs', () => {
  it('writes with missing folders and reads back, without a BOM', async () => {
    const file = memoryFilePath(tempDir());
    expect(await nodeMemoryFs.read(file)).toBeUndefined();
    expect(nodeMemoryFs.readSync(file)).toBeUndefined();
    await nodeMemoryFs.write(file, '﻿# Notes\n- ü\n');
    expect(await nodeMemoryFs.read(file)).toBe('# Notes\n- ü\n');
    expect(nodeMemoryFs.readSync(file)).toBe('# Notes\n- ü\n');
  });

  it('checks that the memory file of a folder stays inside it', async () => {
    const root = tempDir();
    await expect(nodeMemoryFs.checkInside?.(root)).resolves.toBeUndefined();
    const outside = tempDir();
    // 'junction' works without admin rights on Windows and is a plain symlink elsewhere.
    fs.symlinkSync(outside, path.join(root, '.isarflow'), 'junction');
    await expect(nodeMemoryFs.checkInside?.(root)).rejects.toThrow(
      ".isarflow/memory.md leads outside the workspace folder through a symbolic link or junction, so it isn't used.",
    );
  });

  it('refuses memory files that are not UTF-8, so remember cannot garble them', async () => {
    const file = memoryFilePath(tempDir());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // "- Größe" in Latin-1.
    fs.writeFileSync(file, Buffer.from([0x2d, 0x20, 0x47, 0x72, 0xf6, 0xdf, 0x65, 0x0a]));
    await expect(nodeMemoryFs.read(file)).rejects.toThrow(MEMORY_NOT_TEXT);
    // The sidebar only shows a preview, so it still lists the file.
    expect(nodeMemoryFs.readSync(file)).toBeDefined();
  });

  it('rejects read errors other than a missing file', async () => {
    const dir = tempDir();
    await expect(nodeMemoryFs.read(dir)).rejects.toThrow();
  });
});

describe('vscodeMemoryDocuments', () => {
  it('finds open documents and does not edit files that are not open', async () => {
    const uri = vscode.Uri.file('/ws/.isarflow/memory.md');
    const doc = { uri, isDirty: false, getText: () => 'x', save: async () => true };
    vi.spyOn(vscode.workspace, 'textDocuments', 'get').mockReturnValue([
      doc as unknown as vscode.TextDocument,
    ]);
    expect(vscodeMemoryDocuments.find(uri)).toBe(doc);
    expect(vscodeMemoryDocuments.find(vscode.Uri.file('/ws/other.md'))).toBeUndefined();
    expect(await vscodeMemoryDocuments.append(vscode.Uri.file('/ws/other.md'), '- y\n')).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('vscodeMemoryWorkspace', () => {
  it('lists folders and watches the memory file of a folder', () => {
    expect(vscodeMemoryWorkspace.folders()).toEqual([]);
    const watcher = vscodeMemoryWorkspace.watch(vscode.Uri.file('/ws'), () => undefined);
    expect(typeof watcher.dispose).toBe('function');
    watcher.dispose();
    expect(vscodeMemoryWorkspace.folderOf(vscode.Uri.file('/ws/a.md'))).toBeUndefined();
    vscodeMemoryWorkspace.onDidChangeFolders(() => undefined).dispose();
  });
});
