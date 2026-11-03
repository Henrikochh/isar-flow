import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { newMemoryText, type StepIO } from '@isar-flow/core';
import type { EditJournalWriter } from '../../../src/contracts';
import { createMemoryService } from '../../../src/memory/memoryService';
import {
  fakeDocuments,
  FakeDocument,
  fakeFs,
  fakeLog,
  fakeWorkspace,
  folder,
  memoryPath,
} from './memoryFakes';

const ROOT = '/ws/a';
const FILE = memoryPath(ROOT);
const DAY = new Date(2026, 10, 3, 12, 0, 0);

const io = (stepId = 'learn'): StepIO => ({
  runId: 'run-1',
  stepId,
  signal: new AbortController().signal,
  log: () => undefined,
});

function memoryFor(
  files: Record<string, string> = {},
  open: Record<string, FakeDocument> = {},
  options: { journal?: EditJournalWriter; secrets?: string[] } = {},
) {
  const fs = fakeFs(files);
  const docs = fakeDocuments(open);
  const { log } = fakeLog();
  const service = createMemoryService(
    { log },
    {
      fs: fs.fs,
      documents: docs.documents,
      workspace: fakeWorkspace([folder(ROOT, 'a')]).workspace,
      debounceMs: 0,
      now: () => DAY,
    },
  );
  return { memory: service.forRun(ROOT, options), service, ...fs, ...docs };
}

describe('MemoryService.forRun read', () => {
  it('reads the file, an open editor first, and undefined when it is missing', async () => {
    const signal = new AbortController().signal;
    expect(await memoryFor({ [FILE]: 'disk' }).memory.read(signal)).toBe('disk');
    expect(await memoryFor().memory.read(signal)).toBeUndefined();
    const open = memoryFor({ [FILE]: 'disk' }, { [FILE]: new FakeDocument('editor', true) });
    expect(await open.memory.read(signal)).toBe('editor');
  });
});

describe('MemoryService.forRun outside the workspace', () => {
  it('never reads or writes a memory file that a link or junction leads outside the folder', async () => {
    const outside = 'The memory file leads outside the workspace folder.';
    const journal = { beforeWrite: vi.fn(async () => undefined) };
    const t = memoryFor({ [FILE]: 'private' }, { [FILE]: new FakeDocument('private') }, { journal });
    t.fs.checkInside.mockRejectedValue(new Error(outside));
    await expect(t.memory.read(new AbortController().signal)).rejects.toThrow(outside);
    await expect(t.memory.append('Fact.', io())).rejects.toThrow(outside);
    expect(t.fs.checkInside).toHaveBeenCalledWith(ROOT);
    expect(journal.beforeWrite).not.toHaveBeenCalled();
    expect(t.append).not.toHaveBeenCalled();
    expect(t.write).not.toHaveBeenCalled();
  });
});

describe('MemoryService.forRun append', () => {
  it('creates a missing file with the header and a dated bullet', async () => {
    const t = memoryFor();
    expect(await t.memory.append('Tests run with  npm test.', io())).toBe(
      '- 2026-11-03: Tests run with npm test.',
    );
    expect(t.files.get(FILE)).toBe(`${newMemoryText()}- 2026-11-03: Tests run with npm test.\n`);
  });

  it('appends to an existing file and adds a missing line break first', async () => {
    const t = memoryFor({ [FILE]: '# Notes\n- old' });
    await t.memory.append('New fact.', io());
    expect(t.files.get(FILE)).toBe('# Notes\n- old\n- 2026-11-03: New fact.\n');
  });

  it('tells the journal before writing, with the unsaved text of a dirty editor', async () => {
    const order: string[] = [];
    const journal = {
      beforeWrite: vi.fn(
        async (_path: string, _stepId: string, _unsaved?: string) => void order.push('journal'),
      ),
    };
    const t = memoryFor({ [FILE]: 'saved\n' }, {}, { journal });
    t.write.mockImplementation(async () => void order.push('write'));
    await t.memory.append('Fact.', io('learn'));
    expect(journal.beforeWrite).toHaveBeenCalledWith(FILE, 'learn', undefined);
    expect(order).toEqual(['journal', 'write']);

    const dirty = memoryFor(
      { [FILE]: 'saved\n' },
      { [FILE]: new FakeDocument('saved\nunsaved\n', true) },
      { journal },
    );
    await dirty.memory.append('Fact.', io('learn'));
    expect(journal.beforeWrite).toHaveBeenLastCalledWith(FILE, 'learn', 'saved\nunsaved\n');
  });

  it('edits an open document and saves it when it had no unsaved changes', async () => {
    const clean = new FakeDocument('# Notes\n');
    const t = memoryFor({ [FILE]: '# Notes\n' }, { [FILE]: clean });
    await t.memory.append('Fact.', io());
    expect(t.append).toHaveBeenCalledWith(vscode.Uri.file(FILE), '- 2026-11-03: Fact.\n');
    expect(clean.text).toBe('# Notes\n- 2026-11-03: Fact.\n');
    expect(clean.saves).toBe(1);
    expect(t.write).not.toHaveBeenCalled();

    const dirty = new FakeDocument('# Notes\nunsaved', true);
    const d = memoryFor({ [FILE]: '# Notes\n' }, { [FILE]: dirty });
    await d.memory.append('Fact.', io());
    expect(dirty.text).toBe('# Notes\nunsaved\n- 2026-11-03: Fact.\n');
    expect(dirty.saves).toBe(0);
  });

  it('fails clearly when the editor refuses the change', async () => {
    const t = memoryFor({}, { [FILE]: new FakeDocument('x\n') });
    t.append.mockResolvedValueOnce(false);
    await expect(t.memory.append('Fact.', io())).rejects.toThrow(
      'Could not change .isarflow/memory.md. Close its editor and try again.',
    );
  });

  it('refuses empty, long and secret notes before touching the file', async () => {
    const journal = { beforeWrite: vi.fn(async () => undefined) };
    const t = memoryFor({}, {}, { journal, secrets: ['sk-live-1234'] });
    await expect(t.memory.append('  ', io())).rejects.toThrow('The note is empty');
    await expect(t.memory.append('x'.repeat(501), io())).rejects.toThrow('too long');
    await expect(t.memory.append('key is sk-live-1234', io())).rejects.toThrow('secret value');
    expect(journal.beforeWrite).not.toHaveBeenCalled();
    expect(t.write).not.toHaveBeenCalled();
  });

  it('refuses to grow a file over 64 KB', async () => {
    const t = memoryFor({ [FILE]: 'x'.repeat(65_537) });
    await expect(t.memory.append('Fact.', io())).rejects.toThrow(
      'The project memory is over 64 KB. Ask the user to tidy .isarflow/memory.md.',
    );
    expect(t.write).not.toHaveBeenCalled();
  });

  it('writes notes one after the other', async () => {
    const t = memoryFor({ [FILE]: '' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realWrite = t.write.getMockImplementation()!;
    t.write.mockImplementationOnce(async (file, text) => {
      await gate;
      await realWrite(file, text);
    });
    const first = t.memory.append('First.', io());
    const second = t.memory.append('Second.', io());
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await Promise.all([first, second]);
    expect(t.files.get(FILE)).toBe('- 2026-11-03: First.\n- 2026-11-03: Second.\n');
  });

  it('keeps the queue going after a failed write', async () => {
    const t = memoryFor();
    t.write.mockRejectedValueOnce(new Error('disk full'));
    await expect(t.memory.append('First.', io())).rejects.toThrow('disk full');
    await t.memory.append('Second.', io());
    expect(t.files.get(FILE)).toBe(`${newMemoryText()}- 2026-11-03: Second.\n`);
  });

  it('fires onDidChange after a note was saved', async () => {
    const t = memoryFor();
    const changed = vi.fn();
    t.service.onDidChange(changed);
    await t.memory.append('Fact.', io());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(changed).toHaveBeenCalled();
    expect(t.service.files()[0].exists).toBe(true);
  });
});
