import type * as vscode from 'vscode';

/** The VS Code UI for picking a workspace folder (injected for tests). */
export interface FolderUi {
  workspaceFolders(): readonly { name: string; uri: vscode.Uri }[];
  showQuickPick<T extends vscode.QuickPickItem>(
    items: T[],
    options: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
}

/** A folder to create a file in, none (no folder open), or 'dismissed' when the user closed the pick. */
export type FolderChoice = vscode.Uri | undefined | 'dismissed';

interface FolderItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

/** The only workspace folder, or the one the user picks in a multi-root workspace. */
export async function pickWorkspaceFolder(
  ui: FolderUi,
  placeHolder: string,
  title?: string,
): Promise<FolderChoice> {
  const folders = ui.workspaceFolders();
  if (folders.length <= 1) return folders[0]?.uri;
  const items: FolderItem[] = folders.map((f) => ({ label: f.name, description: f.uri.fsPath, uri: f.uri }));
  const picked = await ui.showQuickPick(items, { title, placeHolder });
  return picked ? picked.uri : 'dismissed';
}

export const WORKFLOW_FOLDER_PROMPT = 'Which workspace folder should the workflow be saved in?';
export const AGENT_FOLDER_PROMPT = 'Which workspace folder should the agent be saved in?';
