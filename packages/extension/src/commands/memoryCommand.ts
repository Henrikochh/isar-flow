import * as vscode from 'vscode';
import type { MemoryService } from '../contracts';
import { type FolderUi, pickWorkspaceFolder } from './folders';

export const OPEN_MEMORY_COMMAND = 'isarFlow.openMemory';
export const MEMORY_FOLDER_PROMPT = "Which workspace folder's project memory should open?";
const NO_FOLDER = 'Open a workspace folder to use the project memory.';

export interface MemoryCommandUi extends FolderUi {
  showError(message: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !(value instanceof vscode.Uri);

/** A folder from a command argument: a Uri, a URI string or `{ folderUri }` (sidebar, tests). */
function folderArg(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (typeof arg === 'string' && arg.trim() !== '') return vscode.Uri.parse(arg);
  return isRecord(arg) ? folderArg(arg.folderUri) : undefined;
}

/**
 * Isar Flow: Open project memory. Opens `.isarflow/memory.md` of a workspace folder (created with a short header
 * when missing); in a multi-root workspace it asks which folder.
 */
export function createOpenMemory(
  memory: Pick<MemoryService, 'open'>,
  ui: MemoryCommandUi,
): (arg?: unknown) => Promise<void> {
  return async (arg) => {
    let folder = folderArg(arg);
    if (!folder) {
      const choice = await pickWorkspaceFolder(ui, MEMORY_FOLDER_PROMPT);
      if (choice === 'dismissed') return;
      if (!choice) return ui.showError(NO_FOLDER);
      folder = choice;
    }
    try {
      await memory.open(folder);
    } catch (error) {
      ui.showError(
        `Could not open the project memory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

export function registerMemoryCommand(memory: Pick<MemoryService, 'open'>): vscode.Disposable {
  const open = createOpenMemory(memory, {
    workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
    showError: (message) => void vscode.window.showErrorMessage(message),
  });
  return vscode.commands.registerCommand(OPEN_MEMORY_COMMAND, open);
}
