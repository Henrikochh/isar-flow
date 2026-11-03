import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { createOpenMemory, MEMORY_FOLDER_PROMPT } from '../../../src/commands/memoryCommand';
import { fakeMemory } from '../editors/fakes';

function setup(folders: string[]) {
  const memory = fakeMemory();
  const errors: string[] = [];
  const picks: string[][] = [];
  const pick = { answer: undefined as string | undefined };
  const openMemory = createOpenMemory(memory.service, {
    workspaceFolders: () => folders.map((path) => ({ name: path.slice(1), uri: vscode.Uri.file(path) })),
    showQuickPick: async <T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions) => {
      picks.push(items.map((item) => item.label));
      expect(options.placeHolder).toBe(MEMORY_FOLDER_PROMPT);
      return items.find((item) => item.label === pick.answer);
    },
    showError: (message) => void errors.push(message),
  });
  const opened = () => memory.service.open.mock.calls.map(([folder]) => folder?.toString());
  return { memory, errors, picks, pick, openMemory, opened };
}

describe('Open project memory', () => {
  it('opens the memory of the only folder', async () => {
    const { openMemory, opened, picks } = setup(['/w']);
    await openMemory();
    expect(opened()).toEqual(['file:///w']);
    expect(picks).toEqual([]);
  });

  it('asks for the folder in a multi-root workspace', async () => {
    const { openMemory, opened, pick, picks } = setup(['/a', '/b']);
    pick.answer = 'b';
    await openMemory();
    expect(picks).toEqual([['a', 'b']]);
    expect(opened()).toEqual(['file:///b']);
  });

  it('does nothing when the folder pick is closed', async () => {
    const { openMemory, opened } = setup(['/a', '/b']);
    await openMemory();
    expect(opened()).toEqual([]);
  });

  it('takes a folder argument (Uri or string) without asking', async () => {
    const { openMemory, opened, picks } = setup(['/a', '/b']);
    await openMemory(vscode.Uri.file('/b'));
    await openMemory('file:///a');
    await openMemory({ folderUri: 'file:///b' });
    expect(opened()).toEqual(['file:///b', 'file:///a', 'file:///b']);
    expect(picks).toEqual([]);
  });

  it('says what to do without a workspace folder', async () => {
    const { openMemory, opened, errors } = setup([]);
    await openMemory();
    expect(opened()).toEqual([]);
    expect(errors).toEqual(['Open a workspace folder to use the project memory.']);
  });

  it('shows why the file could not be opened', async () => {
    const { openMemory, errors, memory } = setup(['/w']);
    memory.service.open.mockRejectedValueOnce(new Error('EROFS'));
    await openMemory();
    expect(errors).toEqual(['Could not open the project memory: EROFS']);
  });
});
