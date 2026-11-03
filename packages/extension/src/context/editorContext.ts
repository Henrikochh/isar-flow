import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { EditorContext } from '@isar-flow/core';

/** Cap of `editor.selection` in UTF-8 bytes. */
export const SELECTION_MAX_BYTES = 100 * 1024;

const CAPTURED_SCHEMES = new Set(['file', 'untitled']);
const ISAR_FLOW_FILE = /\.(?:workflow|agent)\.ya?ml$/i;

/** The parts of a text editor the capture reads (vscode.TextEditor fits). */
export interface EditorLike {
  readonly document: {
    readonly uri: vscode.Uri;
    readonly languageId: string;
    readonly isUntitled: boolean;
    getText(range?: vscode.Range): string;
  };
  readonly selection: { readonly active: vscode.Position };
  readonly selections: readonly vscode.Selection[];
}

/** What a run sees of an editor, read once (the editor can change while a QuickPick is open). */
export interface EditorSnapshot {
  uri: vscode.Uri;
  untitled: boolean;
  language: string;
  /** Non-empty selections in document order, joined with a newline, cut at SELECTION_MAX_BYTES. */
  selection: string;
  /** 1-based line of the primary selection's cursor. */
  line: number;
}

/** Files and untitled documents, but not Isar Flow's own workflow and agent files. */
export function isCapturableDocument(document: { readonly uri: vscode.Uri }): boolean {
  return CAPTURED_SCHEMES.has(document.uri.scheme) && !ISAR_FLOW_FILE.test(document.uri.path);
}

/** The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes without splitting a character. */
export function cutUtf8(text: string, maxBytes: number): string {
  // A UTF-16 code unit never takes more than 3 UTF-8 bytes.
  if (text.length * 3 <= maxBytes) return text;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** `fsPath` relative to `root` with forward slashes when it is inside; otherwise the path as given. */
export function relativeFile(fsPath: string, root: string): string {
  if (!root) return fsPath;
  const relative = path.relative(root, fsPath);
  const outside =
    relative === '' || relative === '..' || /^\.\.[\\/]/.test(relative) || path.isAbsolute(relative);
  return outside ? fsPath : relative.replace(/\\/g, '/');
}

const byPosition = (a: vscode.Selection, b: vscode.Selection) =>
  a.start.line - b.start.line || a.start.character - b.start.character;

export function snapshotEditor(editor: EditorLike): EditorSnapshot {
  const { document } = editor;
  const selection = editor.selections
    .filter((s) => !s.isEmpty)
    .sort(byPosition)
    .map((s) => document.getText(s))
    .join('\n');
  return {
    uri: document.uri,
    untitled: document.isUntitled || document.uri.scheme === 'untitled',
    language: document.languageId,
    selection: cutUtf8(selection, SELECTION_MAX_BYTES),
    line: editor.selection.active.line + 1,
  };
}

/** `editor.*` of a run whose workspace folder is `root` (absolute path; '' when there is none). */
export function editorContextFor(snapshot: EditorSnapshot, root: string): EditorContext {
  return {
    selection: snapshot.selection,
    file: snapshot.untitled ? '' : relativeFile(snapshot.uri.fsPath, root),
    language: snapshot.language,
    line: snapshot.line,
  };
}
