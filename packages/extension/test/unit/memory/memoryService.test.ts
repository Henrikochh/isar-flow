import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { MEMORY_NOT_TEXT, newMemoryText } from '@isar-flow/core';
import { createMemoryService, type MemoryServiceOptions } from '../../../src/memory/memoryService';
import {
  fakeDocuments,
  FakeDocument,
  fakeFs,
  fakeLog,
  fakeWorkspace,
  folder,
  memoryPath,
} from './memoryFakes';

const A = folder('/ws/a', 'a');
const B = folder('/ws/b', 'b');

function service(
  files: Record<string, string> = {},
  open: Record<string, FakeDocument> = {},
  folders = [A, B],
  extra: Partial<MemoryServiceOptions> = {},
) {
  const fs = fakeFs(files);
  const docs = fakeDocuments(open);
  const ws = fakeWorkspace(folders);
  const { log, lines } = fakeLog();
  const memory = createMemoryService(
    { log },
    { fs: fs.fs, documents: docs.documents, workspace: ws.workspace, debounceMs: 0, ...extra },
  );
  return { memory, ...fs, ...docs, ...ws, lines };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createMemoryService files', () => {
  it('lists the memory file of every folder, missing ones included', () => {
    const { memory } = service({ [memoryPath('/ws/a')]: '# Project memory\n\n- 2026-11-03: Use pnpm.\n' });
    expect(memory.files()).toEqual([
      {
        uri: vscode.Uri.file(memoryPath('/ws/a')).toString(),
        folderUri: A.uri.toString(),
        folderName: 'a',
        path: '.isarflow/memory.md',
        exists: true,
        bytes: 42,
        overLimit: false,
        preview: '# Project memory\n\n- 2026-11-03: Use pnpm.',
      },
      {
        uri: vscode.Uri.file(memoryPath('/ws/b')).toString(),
        folderUri: B.uri.toString(),
        folderName: 'b',
        path: '.isarflow/memory.md',
        exists: false,
        bytes: 0,
        overLimit: false,
        preview: '',
      },
    ]);
  });

  it('counts UTF-8 bytes and flags files over 8 KB', () => {
    const { memory } = service({ [memoryPath('/ws/a')]: 'ü'.repeat(4097) });
    const [state] = memory.files();
    expect(state.bytes).toBe(8194);
    expect(state.overLimit).toBe(true);
  });

  it('previews whole lines up to 600 characters', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `- note ${i} ${'x'.repeat(20)}`);
    const { memory } = service({ [memoryPath('/ws/a')]: lines.join('\r\n') });
    const { preview } = memory.files()[0];
    expect(preview.length).toBeLessThanOrEqual(600);
    expect(preview.startsWith('- note 0')).toBe(true);
    expect(preview.split('\n').every((line) => lines.includes(line))).toBe(true);

    const long = service({ [memoryPath('/ws/a')]: 'y'.repeat(900) }).memory.files()[0].preview;
    expect(long).toHaveLength(600);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reads an open editor first, unsaved edits included', () => {
    const { memory } = service(
      { [memoryPath('/ws/a')]: 'on disk' },
      { [memoryPath('/ws/a')]: new FakeDocument('in the editor', true) },
    );
    expect(memory.files()[0].preview).toBe('in the editor');
  });

  it('caches states until something changes, then fires onDidChange once (debounced)', async () => {
    vi.useFakeTimers();
    const t = service({ [memoryPath('/ws/a')]: 'one' }, {}, [A, B], { debounceMs: 300 });
    const changed = vi.fn();
    t.memory.onDidChange(changed);
    expect(t.memory.files()[0].preview).toBe('one');
    t.files.set(memoryPath('/ws/a'), 'two');
    expect(t.memory.files()[0].preview).toBe('one');

    t.watchers[0].onChange();
    t.changes.fire(vscode.Uri.file(memoryPath('/ws/b')));
    t.changes.fire(vscode.Uri.file('/ws/a/src/other.ts'));
    expect(t.memory.files()[0].preview).toBe('two');
    await vi.advanceTimersByTimeAsync(299);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('ignores text changes of other files', async () => {
    vi.useFakeTimers();
    const t = service({}, {}, [A], { debounceMs: 300 });
    const changed = vi.fn();
    t.memory.onDidChange(changed);
    t.changes.fire(vscode.Uri.file('/ws/a/README.md'));
    await vi.advanceTimersByTimeAsync(400);
    expect(changed).not.toHaveBeenCalled();
  });

  it('watches every folder and follows folder changes', async () => {
    const t = service({}, {}, [A]);
    expect(t.watchers.map((w) => [w.folder, w.disposed])).toEqual([[A.uri.path, false]]);
    const changed = vi.fn();
    t.memory.onDidChange(changed);
    t.folders.push(B);
    t.folderChanges.fire();
    expect(t.watchers.map((w) => [w.folder, w.disposed])).toEqual([
      [A.uri.path, true],
      [A.uri.path, false],
      [B.uri.path, false],
    ]);
    expect(t.memory.files()).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(changed).toHaveBeenCalled();
    t.memory.dispose();
    expect(t.watchers.every((w) => w.disposed)).toBe(true);
  });

  it('has no files without workspace folders', () => {
    const { memory } = service({}, {}, []);
    expect(memory.files()).toEqual([]);
    expect(memory.stateFor(vscode.Uri.file('/else/x.agent.yaml'))).toBeUndefined();
  });
});

describe('createMemoryService stateFor', () => {
  it('uses the folder of the file, else the first folder', () => {
    const { memory } = service();
    expect(memory.stateFor(vscode.Uri.file('/ws/b/.isarflow/agents/coder.agent.yaml'))?.folderName).toBe('b');
    expect(memory.stateFor(vscode.Uri.file('/home/me/.isarflow/agents/coder.agent.yaml'))?.folderName).toBe(
      'a',
    );
  });
});

describe('createMemoryService open', () => {
  it('creates a missing file with the header and shows it', async () => {
    const t = service();
    await t.memory.open(B.uri);
    expect(t.files.get(memoryPath('/ws/b'))).toBe(newMemoryText());
    expect(t.show).toHaveBeenCalledWith(vscode.Uri.file(memoryPath('/ws/b')));
  });

  it('opens an existing file of the first folder without changing it', async () => {
    const t = service({ [memoryPath('/ws/a')]: 'mine' });
    await t.memory.open();
    expect(t.write).not.toHaveBeenCalled();
    expect(t.files.get(memoryPath('/ws/a'))).toBe('mine');
    expect(t.show).toHaveBeenCalledWith(vscode.Uri.file(memoryPath('/ws/a')));
  });

  it('does not overwrite a file that is only open in an editor', async () => {
    const t = service({}, { [memoryPath('/ws/a')]: new FakeDocument('unsaved', true) });
    await t.memory.open(A.uri);
    expect(t.write).not.toHaveBeenCalled();
  });

  it('shows a file that is not UTF-8 without rewriting it, so it can be saved as UTF-8', async () => {
    const t = service();
    t.fs.read.mockRejectedValueOnce(new Error(MEMORY_NOT_TEXT));
    await t.memory.open(A.uri);
    expect(t.write).not.toHaveBeenCalled();
    expect(t.show).toHaveBeenCalledWith(vscode.Uri.file(memoryPath('/ws/a')));
  });

  it('neither creates nor shows a memory file that a link leads outside the folder', async () => {
    const t = service();
    t.fs.checkInside.mockRejectedValueOnce(new Error('outside'));
    await expect(t.memory.open(A.uri)).rejects.toThrow('outside');
    expect(t.fs.checkInside).toHaveBeenCalledWith(A.uri.fsPath);
    expect(t.write).not.toHaveBeenCalled();
    expect(t.show).not.toHaveBeenCalled();
  });

  it('says what to do without a workspace folder', async () => {
    const t = service({}, {}, []);
    await expect(t.memory.open()).rejects.toThrow('Open a folder');
  });
});
