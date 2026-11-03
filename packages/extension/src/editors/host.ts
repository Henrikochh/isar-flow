import type * as vscode from 'vscode';
import type { Range } from '@isar-flow/core';

/** The text document behind a custom editor, as the panel controllers use it. */
export interface EditorDocument {
  readonly uri: vscode.Uri;
  readonly isDirty: boolean;
  getText(): string;
  save(): Promise<boolean>;
  /**
   * Applies the smallest edit that turns `oldText` into `newText`. Resolves false when the document no longer
   * has `oldText` or VS Code refused the edit.
   */
  replaceText(oldText: string, newText: string): Promise<boolean>;
  /** Opens the YAML text editor beside the panel, revealing `range` when given. */
  showYaml(range?: Range): Promise<void>;
}

/** Window and workspace functions the panels need; injected so the panels can be unit-tested. */
export interface EditorUi {
  isTrusted(): boolean;
  /** Open workspace folders, in order. */
  workspaceFolders(): readonly vscode.Uri[];
  /** The workspace folder that contains `uri`; undefined for files outside all folders (e.g. user agents). */
  workspaceFolderOf(uri: vscode.Uri): vscode.Uri | undefined;
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  writeClipboard(text: string): Promise<void>;
  /** Shows an information message with one action; resolves true when the user picked it. */
  confirm(message: string, action: string): Promise<boolean>;
  showError(message: string): void;
  showInfo(message: string): void;
}

export const WORKFLOW_EDITOR_VIEW_TYPE = 'isarFlow.workflowEditor';
export const AGENT_EDITOR_VIEW_TYPE = 'isarFlow.agentEditor';

/** Delay before a text change is sent to the webview. */
export const DOCUMENT_DEBOUNCE_MS = 150;

export const WRITE_FAILED =
  'The change could not be written to the file. Check that the file is not read-only, then try again.';
export const DOCUMENT_CHANGED = 'The file changed while the edit was being applied. Try again.';
